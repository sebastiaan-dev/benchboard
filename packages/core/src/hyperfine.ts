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

const TIME_UNITS: Record<string, number> = { second: 1, millisecond: 1e-3, microsecond: 1e-6, nanosecond: 1e-9 };
const BYTE_UNITS: Record<string, number> = { byte: 1, kilobyte: 1e3, kibibyte: 1024, megabyte: 1e6, mebibyte: 1024 ** 2 };

/** A `{ value, unit }` quantity from a schema-2 export, converted to seconds or bytes. */
function quantity(value: unknown, units: Record<string, number>, field: string): number {
	if (!isObject(value) || typeof value.unit !== "string" || !(value.unit in units)) throw new Error(`${field} must be a { value, unit } quantity in ${Object.keys(units).join("/")}.`);
	return nonnegative(value.value, field) * units[value.unit];
}

/**
 * Hyperfine 2 exports (`schema_version: 2`) keep per-run measurements with units and summaries per
 * metric. They are converted to the 1.x shape (seconds, `times`, `exit_codes`, `memory_usage_byte`),
 * so both are validated the same way: wall-clock time is the benchmark statistic either way.
 */
function fromSchema2(data: Record<string, unknown>): Record<string, unknown>[] {
	if (!Array.isArray(data.results)) return [];
	return data.results.map((entry: unknown, index: number) => {
		const where = `Result ${index + 1}`;
		if (!isObject(entry) || !Array.isArray(entry.measurements)) throw new Error(`${where} has no measurements.`);
		const runs = entry.measurements.slice(0, MAX_SAMPLES + 1);
		const runAt = (run: unknown, position: number) => {
			if (!isObject(run)) throw new Error(`${where} measurement ${position + 1} is not an object.`);
			return run;
		};
		const times = runs.map((run, position) => quantity(runAt(run, position).time_wall_clock, TIME_UNITS, `${where} wall-clock time`));
		const hasMemory = runs.length > 0 && runs.every((run) => isObject(run) && run.memory_peak_resident !== undefined && run.memory_peak_resident !== null);
		const summary = isObject(entry.summary) ? entry.summary : {};
		const wall = isObject(summary.time_wall_clock) ? summary.time_wall_clock : {};
		const scale = typeof wall.unit === "string" && wall.unit in TIME_UNITS ? TIME_UNITS[wall.unit] : 1;
		const summarized = (key: string) => typeof wall[key] === "number" ? (wall[key] as number) * scale : wall[key];
		const mean = (metric: string) => {
			const values = runs.map((run) => isObject(run) && run[metric] !== undefined ? quantity(run[metric], TIME_UNITS, `${where} ${metric}`) : null);
			return values.every((value) => value !== null) && values.length ? values.reduce((sum, value) => sum + value!, 0) / values.length : null;
		};
		const parameters = isObject(entry.parameters)
			? Object.fromEntries(Object.entries(entry.parameters).map(([key, value]) => [key, isObject(value) ? value.value : value]))
			: undefined;
		return {
			command: entry.command,
			times,
			// A run killed by a signal has no exit code; it did not pass.
			exit_codes: runs.map((run) => isObject(run) ? (Number.isSafeInteger(run.exit_code) ? run.exit_code : -1) : -1),
			memory_usage_byte: hasMemory ? runs.map((run) => quantity((run as Record<string, unknown>).memory_peak_resident, BYTE_UNITS, `${where} peak memory`)) : undefined,
			mean: summarized("mean"), median: summarized("median"), min: summarized("min"), max: summarized("max"), stddev: summarized("stddev"),
			user: mean("time_user"), system: mean("time_system"),
			parameters,
		};
	});
}

/** Validates a Hyperfine `--export-json` document (1.x or 2.x) and recomputes statistics from raw samples. */
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
	const version = data.schema_version ?? 1;
	if (version !== 1 && version !== 2) throw new Error(`Unsupported Hyperfine export schema version ${String(version)}; upgrade benchboard.`);
	const results = version === 2 ? fromSchema2(data) : data.results;
	return results.map((entry: unknown, index: number): ExportedCase => {
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
