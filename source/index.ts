import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getInput, info, summary, warning } from "@actions/core";
import { diffLines } from "diff";
import { MAXIMUM_CONTENT_LENGTH } from "./utility/constants.ts";
import { isRecord, prettyJSON } from "./utility/functions.ts";

type SnapshotCheckResult =
	| {
			changed: false;
			name: string;
			snapshot: string;
			status: "unchanged";
	  }
	| {
			changed: true;
			diff: string;
			name: string;
			snapshot: string;
			status: "changed";
	  }
	| {
			changed: true;
			name: string;
			snapshot: string;
			status: "baseline";
	  };

type EndpointResult =
	| SnapshotCheckResult
	| {
			changed: false;
			error: string;
			name: string;
			snapshot: string;
			status: "failed";
	  };

const buildAccessKey = getInput("sky_build_access_key", { required: true });
const discordWebhookURL = getInput("discord_webhook_url", { required: true });
const userAgent = getInput("sky_user_agent", { required: true });

async function readSnapshot(path: string) {
	try {
		const content = await readFile(path, "utf8");
		const parsed: unknown = JSON.parse(content);

		if (!isRecord(parsed)) {
			throw new Error(`${path} must contain a JSON object.`);
		}

		return parsed;
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") {
			return null;
		}

		throw error;
	}
}

async function writeSnapshot(snapshotPath: string, json: string) {
	await mkdir(dirname(snapshotPath), { recursive: true });
	await writeFile(snapshotPath, json);
}

async function fetchJSON(path: string) {
	const response = await fetch(`https://live.radiance.thatgamecompany.com${path}`, {
		body: "{}",
		headers: {
			"Content-Type": "application/json",
			"User-Agent": userAgent,
			"x-sky-build-access-key": buildAccessKey,
		},
		method: "POST",
	});

	const body = await response.text();

	if (!response.ok) {
		throw new Error(`${path} returned HTTP ${response.status}: ${body}`);
	}

	const data: unknown = JSON.parse(body);

	if (!isRecord(data)) {
		throw new Error(`${path} returned a non-object JSON response.`);
	}

	return data;
}

async function fetchVars() {
	const data = await fetchJSON("/account/get_vars");
	const { vars } = data;

	if (!isRecord(vars)) {
		throw new Error("Expected get_vars response to contain a vars object.");
	}

	return vars;
}

async function fetchLatestBuildVersion() {
	return fetchJSON("/account/get_latest_build_version");
}

async function sendDiscordMessage(content: string) {
	if (content.length > MAXIMUM_CONTENT_LENGTH) {
		const formData = new FormData();
		formData.append(
			"files[0]",
			new Blob([content], { type: "text/plain;charset=utf-8" }),
			"results.diff",
		);

		const response = await fetch(discordWebhookURL, {
			body: formData,
			method: "POST",
		});

		if (!response.ok) {
			throw new Error(`Discord webhook returned HTTP ${response.status}: ${await response.text()}`);
		}

		return;
	}

	const response = await fetch(discordWebhookURL, {
		body: JSON.stringify({ content }),
		headers: { "Content-Type": "application/json" },
		method: "POST",
	});

	if (!response.ok) {
		throw new Error(`Discord webhook returned HTTP ${response.status}: ${await response.text()}`);
	}
}

async function checkSnapshot(
	name: string,
	snapshot: string,
	newValue: Record<string, unknown>,
): Promise<SnapshotCheckResult> {
	const snapshotPath = join("snapshots", snapshot);
	const oldValue = await readSnapshot(snapshotPath);
	const newJSON = prettyJSON(newValue);

	if (oldValue === null) {
		await writeSnapshot(snapshotPath, newJSON);
		info(`${name}: baseline snapshot written.`);
		return { changed: true, name, snapshot, status: "baseline" } as const;
	}

	const oldJSON = prettyJSON(oldValue);

	if (oldJSON === newJSON) {
		info(`${name}: no changes.`);
		return { changed: false, name, snapshot, status: "unchanged" } as const;
	}

	const diff = diffJSON(oldJSON, newJSON);
	await sendDiscordMessage(`## ${name} changed\n\`\`\`diff\n${diff}\n\`\`\``);
	await writeSnapshot(snapshotPath, newJSON);
	info(`${name}: changes detected.`);
	return { changed: true, diff, name, snapshot, status: "changed" } as const;
}

function diffJSON(old: string, updated: string) {
	let result = "";

	for (const part of diffLines(old, updated)) {
		const prefix = part.added ? "+" : part.removed ? "-" : " ";
		const lines = part.value.split("\n");

		if (lines.at(-1) === "") {
			lines.pop();
		}

		for (const line of lines) {
			result += `${prefix}${line}\n`;
		}
	}

	return result.trimEnd();
}

function getErrorMessage(error: unknown) {
	if (error instanceof Error) {
		return error.message;
	}

	return String(error);
}

interface Endpoint {
	fetch(): Promise<Record<string, unknown>>;
	name: string;
	snapshot: string;
}

const ENDPOINTS = [
	{ fetch: fetchVars, name: "/account/get_vars", snapshot: "get-vars.json" },
	{
		fetch: fetchLatestBuildVersion,
		name: "/account/get_latest_build_version",
		snapshot: "get-latest-build-version.json",
	},
] as const satisfies readonly Endpoint[];

const results = await Promise.all(
	ENDPOINTS.map<Promise<EndpointResult>>(async ({ fetch, name, snapshot }) => {
		try {
			return await checkSnapshot(name, snapshot, await fetch());
		} catch (error) {
			return {
				changed: false,
				error: getErrorMessage(error),
				name,
				snapshot,
				status: "failed",
			};
		}
	}),
);

const result = summary.addHeading("Results");

for (const endpointResult of results) {
	result.addHeading(endpointResult.name, 2).addEOL();

	switch (endpointResult.status) {
		case "baseline":
			result.addRaw("_Baseline snapshot written_", true);
			break;
		case "changed":
			result.addCodeBlock(endpointResult.diff, "diff");
			break;
		case "failed":
			result.addRaw(`_Failed: ${endpointResult.error}_`, true);
			break;
		case "unchanged":
			result.addRaw("_No change_", true);
			break;
	}
}

await result.write();

const failures = results.filter((result) => result.status === "failed");

if (failures.length > 0) {
	if (failures.length === results.length) {
		throw new Error(`All ${failures.length} endpoint checks failed.`);
	}

	warning(`${failures.length} of ${results.length} endpoint checks failed.`);
}
