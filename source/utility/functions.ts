export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function prettyJSON(value: unknown) {
	return JSON.stringify(value, null, "\t");
}
