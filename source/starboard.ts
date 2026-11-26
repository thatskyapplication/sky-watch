import {
	ALL_DAY_DURATION,
	SKY_TIME_ZONE,
	STARBOARD_LANGUAGE,
	STARBOARD_REQUEST_TIMEOUT,
	STARBOARD_URL,
} from "./utility/constants.ts";
import { isRecord } from "./utility/functions.ts";

interface CalendarOccurrence {
	date: string;
	duration: number;
	end: string;
	id: string;
	start: string;
}

interface CalendarEntry {
	description: string | null;
	location: string | null;
	occurrences: CalendarOccurrence[];
	special: boolean;
	title: string;
	uuid: string;
}

interface CalendarWindow {
	firstStart: string;
	lastDate: string;
}

interface CalendarDates {
	end: string | null;
	start: string | null;
}

interface CalendarSchedule {
	durations: number[];
	times: string[];
	weekdays: string[];
}

interface CalendarEntrySnapshot {
	dates: Record<string, CalendarDates>;
	description: string | null;
	location: string | null;
	schedule: CalendarSchedule | null;
	special: boolean;
	title: string;
}

function isNullableString(value: unknown): value is string | null {
	return value === null || typeof value === "string";
}

async function fetchStarboard(path: string, query: Record<string, string> = {}) {
	const url = new URL(path, STARBOARD_URL);
	url.search = new URLSearchParams(query).toString();
	const response = await fetch(url, { signal: AbortSignal.timeout(STARBOARD_REQUEST_TIMEOUT) });

	if (!response.ok) {
		throw new Error(`${path} returned HTTP ${response.status}.`);
	}

	const data: unknown = await response.json();

	if (!Array.isArray(data) || data.length === 0) {
		throw new Error(`${path} returned no items.`);
	}

	return data as unknown[];
}

function parseCalendarOccurrences(series: unknown) {
	if (!isRecord(series) || typeof series.duration !== "number" || !isRecord(series.events)) {
		throw new Error("Expected each calendar series to have a duration and events.");
	}

	const occurrences: CalendarOccurrence[] = [];

	for (const [date, dateOccurrences] of Object.entries(series.events)) {
		if (!Array.isArray(dateOccurrences)) {
			throw new Error(`Expected the ${date} calendar occurrences to be an array.`);
		}

		for (const occurrence of dateOccurrences) {
			if (
				!isRecord(occurrence) ||
				typeof occurrence.id !== "string" ||
				typeof occurrence.startUTC !== "string" ||
				typeof occurrence.endUTC !== "string"
			) {
				throw new Error("Expected each calendar occurrence to have an id, a start and an end.");
			}

			occurrences.push({
				date,
				duration: series.duration,
				end: occurrence.endUTC,
				id: occurrence.id,
				start: occurrence.startUTC,
			});
		}
	}

	return occurrences;
}

function parseCalendarEntries(data: unknown[]) {
	const entries: CalendarEntry[] = [];

	for (const entry of data) {
		if (
			!isRecord(entry) ||
			typeof entry.uuid !== "string" ||
			typeof entry.title !== "string" ||
			!Array.isArray(entry.event)
		) {
			throw new Error("Expected each calendar entry to have a uuid, a title and events.");
		}

		entries.push({
			description: typeof entry.description === "string" ? entry.description : null,
			location: typeof entry.location === "string" ? entry.location : null,
			occurrences: entry.event.flatMap(parseCalendarOccurrences),
			special: entry.isSpecial === true,
			title: entry.title,
			uuid: entry.uuid,
		});
	}

	return entries;
}

function calendarWindow(entries: readonly CalendarEntry[]): CalendarWindow {
	let firstStart: string | null = null;
	let lastDate: string | null = null;

	for (const entry of entries) {
		for (const occurrence of entry.occurrences) {
			if (firstStart === null || occurrence.start < firstStart) {
				firstStart = occurrence.start;
			}

			if (lastDate === null || occurrence.date > lastDate) {
				lastDate = occurrence.date;
			}
		}
	}

	if (firstStart === null || lastDate === null) {
		throw new Error("/api/getEvents returned no occurrences.");
	}

	return { firstStart, lastDate };
}

function calendarSeries(occurrenceId: string) {
	const [kind, created, random, index] = occurrenceId.split("-");

	if (
		kind === "recurring" &&
		created !== undefined &&
		random !== undefined &&
		index !== undefined
	) {
		return { index: Number(index), recurring: true, series: `${kind}-${created}-${random}` };
	}

	return { index: 0, recurring: false, series: occurrenceId };
}

function previousCalendarDates(previous: Record<string, unknown> | null, uuid: string) {
	const dates: Record<string, CalendarDates> = {};
	const entry = previous?.[uuid];

	if (entry === undefined) {
		return dates;
	}

	if (!(isRecord(entry) && isRecord(entry.dates))) {
		throw new Error(`Expected the ${uuid} calendar snapshot to have dates.`);
	}

	for (const [series, seriesDates] of Object.entries(entry.dates)) {
		if (
			!(
				isRecord(seriesDates) &&
				isNullableString(seriesDates.end) &&
				isNullableString(seriesDates.start)
			)
		) {
			throw new Error(`Expected the ${series} calendar snapshot dates to be strings or null.`);
		}

		dates[series] = { end: seriesDates.end, start: seriesDates.start };
	}

	return dates;
}

function calendarEntrySnapshot(
	entry: CalendarEntry,
	previousDates: Record<string, CalendarDates>,
	window: CalendarWindow,
): CalendarEntrySnapshot {
	const allDaySeries = new Map<string, { first: CalendarOccurrence; last: CalendarOccurrence }>();
	const durations = new Set<number>();
	const times = new Set<string>();
	const weekdays = new Map<number, string>();

	for (const occurrence of entry.occurrences) {
		if (occurrence.duration >= ALL_DAY_DURATION) {
			const { series } = calendarSeries(occurrence.id);
			const bounds = allDaySeries.get(series);

			if (bounds === undefined) {
				allDaySeries.set(series, { first: occurrence, last: occurrence });
			} else {
				if (occurrence.start < bounds.first.start) {
					bounds.first = occurrence;
				}

				if (occurrence.start > bounds.last.start) {
					bounds.last = occurrence;
				}
			}
		} else {
			const start = Temporal.Instant.from(occurrence.start).toZonedDateTimeISO(SKY_TIME_ZONE);
			durations.add(occurrence.duration);
			times.add(start.toPlainTime().toString({ smallestUnit: "minute" }));
			weekdays.set(
				start.dayOfWeek,
				start.toPlainDate().toLocaleString("en-GB", { weekday: "long" }),
			);
		}
	}

	const dates: [string, CalendarDates][] = [];

	for (const [series, { first, last }] of allDaySeries) {
		const { index, recurring } = calendarSeries(first.id);

		dates.push([
			series,
			{
				end: !recurring || last.date < window.lastDate ? last.end : null,
				start: !recurring || index === 0 ? first.start : (previousDates[series]?.start ?? null),
			},
		]);
	}

	for (const [series, seriesDates] of Object.entries(previousDates)) {
		if (
			!allDaySeries.has(series) &&
			seriesDates.end !== null &&
			seriesDates.end <= window.firstStart
		) {
			dates.push([series, seriesDates]);
		}
	}

	dates.sort(
		([firstSeries, firstDates], [secondSeries, secondDates]) =>
			(firstDates.start ?? "").localeCompare(secondDates.start ?? "") ||
			firstSeries.localeCompare(secondSeries),
	);

	return {
		dates: Object.fromEntries(dates),
		description: entry.description,
		location: entry.location,
		schedule:
			durations.size === 0
				? null
				: {
						durations: [...durations].sort((first, second) => first - second),
						times: [...times].sort(),
						weekdays: [...weekdays]
							.sort(([first], [second]) => first - second)
							.map(([, weekday]) => weekday),
					},
		special: entry.special,
		title: entry.title,
	};
}

export async function fetchStarboardCalendar(previous: Record<string, unknown> | null) {
	const entries = parseCalendarEntries(
		await fetchStarboard("/api/getEvents", {
			day: Temporal.Now.plainDateISO(SKY_TIME_ZONE).toString(),
			lang: STARBOARD_LANGUAGE,
			timezone: SKY_TIME_ZONE,
		}),
	);

	const window = calendarWindow(entries);
	const calendar: Record<string, CalendarEntrySnapshot> = {};

	entries.sort(
		(first, second) =>
			first.title.localeCompare(second.title, "en") || first.uuid.localeCompare(second.uuid),
	);

	for (const entry of entries) {
		calendar[entry.uuid] = calendarEntrySnapshot(
			entry,
			previousCalendarDates(previous, entry.uuid),
			window,
		);
	}

	return calendar;
}

export async function fetchStarboardPatchNotes() {
	const patchNotes: Record<string, unknown> = {};

	for (const patchNote of await fetchStarboard("/api/helpshift")) {
		if (
			!isRecord(patchNote) ||
			typeof patchNote.publish_id !== "string" ||
			typeof patchNote.slug !== "string" ||
			typeof patchNote.created_at !== "number" ||
			!isRecord(patchNote.translations)
		) {
			throw new Error(
				"Expected each patch note to have a publish id, a slug, a creation time and translations.",
			);
		}

		const english = patchNote.translations.en;

		patchNotes[patchNote.publish_id] = {
			created: Temporal.Instant.fromEpochMilliseconds(patchNote.created_at).toString(),
			title: isRecord(english) && typeof english.title === "string" ? english.title : null,
			url: `https://thatgamecompany.helpshift.com/hc/en/17-sky-children-of-the-light/faq/${patchNote.publish_id}-${patchNote.slug}`,
		};
	}

	return patchNotes;
}

export async function fetchStarboardNews() {
	const articles: [string, { name: string; published: string | null; url: string }][] = [];

	for (const article of await fetchStarboard("/api/storyblok", {
		lang: STARBOARD_LANGUAGE,
		level: "news",
	})) {
		if (
			!isRecord(article) ||
			typeof article.uuid !== "string" ||
			typeof article.name !== "string" ||
			typeof article.slug !== "string" ||
			!isNullableString(article.first_published_at)
		) {
			throw new Error(
				"Expected each news article to have a uuid, a name, a slug and a publish date.",
			);
		}

		articles.push([
			article.uuid,
			{
				name: article.name,
				published: article.first_published_at,
				url: `${STARBOARD_URL}/news/article/${article.slug}`,
			},
		]);
	}

	articles.sort(
		([firstUUID, first], [secondUUID, second]) =>
			(first.published ?? "").localeCompare(second.published ?? "") ||
			firstUUID.localeCompare(secondUUID),
	);

	return Object.fromEntries(articles);
}
