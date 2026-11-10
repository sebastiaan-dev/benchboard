import { statistics, quantile, type Statistics } from "./stats.ts";

export const MAX_EXPORT_BYTES = 64 * 1024 * 1024;
const MAX_RESULTS = 512;
const MAX_SAMPLES = 100_000;

export type CaseStatus = "passed" | "failed" | "unverified";

export interface ExportedCase extends Statistics {
	command: string;
	times: number[];
	exitCodes: number[] | null;
	status: CaseStatus;
	user: number | null;
	system: number | null;
	rssMedian: number | null;
	rssPeak: number | null;
	parameters: Record<string, string> | null;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value);

function nonnegative(value: unknown, field: string): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		throw new Error(`${field} must be a finite nonnegative number.`);
	}
	return value;
}

function samples(value: unknown, field: string): number[] {
	if (!Array.isArray(value) || value.length === 0 || value.length > MAX_SAMPLES) {
		throw new Error(`${field} must contain 1–${MAX_SAMPLES.toLocaleString("en")} samples.`);
	}
	return value.map((entry) => nonnegative(entry, field));
}

/** Validates a Hyperfine `--export-json` document and recomputes statistics from raw samples. */
export function parseHyperfineExport(bytes: Uint8Array): ExportedCase[] {
	if (bytes.length > MAX_EXPORT_BYTES) throw new Error(`Hyperfine export exceeds ${MAX_EXPORT_BYTES / 1024 / 1024} MiB.`);
	let data: unknown;
	try {
		data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
	} catch (error) {
		throw new Error(`Hyperfine export is not valid UTF-8 JSON: ${(error as Error).message}`);
	}
	if (!isObject(data) || !Array.isArray(data.results) || data.results.length === 0 || data.results.length > MAX_RESULTS) {
		throw new Error(`Expected a Hyperfine JSON export containing 1–${MAX_RESULTS} results.`);
	}
	return data.results.map((entry: unknown, index: number): ExportedCase => {
		const where = `Result ${index + 1}`;
		if (!isObject(entry) || typeof entry.command !== "string" || !entry.command.trim() || entry.command.length > 16_384) {
			throw new Error(`${where} has no valid command.`);
		}
		const times = samples(entry.times, `${where} times`);
		const stats = statistics(times);
		for (const key of ["mean", "median", "min", "max", "stddev"] as const) {
			const exported = entry[key];
			if (exported === undefined || (exported === null && key === "stddev" && times.length === 1)) continue;
			const value = nonnegative(exported, `${where} ${key}`);
			const computed = stats[key];
			if (computed !== null && Math.abs(value - computed) > Math.max(1e-9, computed * 1e-6)) {
				throw new Error(`${where} ${key} disagrees with its samples.`);
			}
		}
		let exitCodes: number[] | null = null;
		if (entry.exit_codes !== undefined && entry.exit_codes !== null) {
			if (!Array.isArray(entry.exit_codes) || entry.exit_codes.length !== times.length ||
				entry.exit_codes.some((code) => !Number.isSafeInteger(code))) {
				throw new Error(`${where} exit codes must be integers matching its samples.`);
			}
			exitCodes = entry.exit_codes as number[];
		}
		let rssMedian: number | null = null;
		let rssPeak: number | null = null;
		if (entry.memory_usage_byte !== undefined && entry.memory_usage_byte !== null) {
			const rss = Float64Array.from(samples(entry.memory_usage_byte, `${where} RSS`)).sort();
			if (rss.length !== times.length) throw new Error(`${where} RSS samples must match timing samples.`);
			rssMedian = quantile(rss, 0.5);
			rssPeak = rss[rss.length - 1];
		}
		let parameters: Record<string, string> | null = null;
		if (isObject(entry.parameters)) {
			parameters = Object.fromEntries(Object.entries(entry.parameters).map(([key, value]) => [key, String(value)]));
		}
		const optional = (value: unknown, field: string) => value === undefined || value === null ? null : nonnegative(value, `${where} ${field}`);
		return {
			...stats,
			command: entry.command,
			times,
			exitCodes,
			status: exitCodes === null ? "unverified" : exitCodes.every((code) => code === 0) ? "passed" : "failed",
			user: optional(entry.user, "user CPU time"),
			system: optional(entry.system, "system CPU time"),
			rssMedian,
			rssPeak,
			parameters,
		};
	});
}
