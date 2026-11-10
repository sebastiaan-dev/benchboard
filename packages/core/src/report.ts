import { bootstrapRatio, seedFrom, type Statistic } from "./stats.ts";
import type { Measurement, PullRequest, Store } from "./store.ts";

export type Verdict = "regression" | "improvement" | "unchanged" | "inconclusive" | "failed";

export interface Comparison {
	candidate: Measurement;
	baseline: Measurement;
	statistic: Statistic;
	/** statistic(candidate) / statistic(baseline); above 1 is slower. */
	ratio: number;
	low: number;
	high: number;
	resamples: number;
	verdict: Verdict;
	/** Both sides were measured in the same Hyperfine invocation, so drift between sessions cannot bias the ratio. */
	sameRun: boolean;
}

export interface ReportOptions {
	statistic?: Statistic;
	includeDirty?: boolean;
	/** Restrict to one machine; defaults to the machine with the most matching measurements. */
	machineId?: number | null;
	/** Relative change considered material, e.g. 0.02 for 2%. */
	threshold?: number;
}

export interface ReportPoint {
	position: number;
	sha: string;
	isBase: boolean;
	measurement: Measurement | null;
	candidates: Measurement[];
	vsReference: Comparison | null;
	vsPrevious: Comparison | null;
}

export interface SeriesReport {
	benchmarkId: number;
	caseKey: string;
	label: string;
	points: ReportPoint[];
	reference: ReportPoint | null;
	referenceIsBase: boolean;
	latest: ReportPoint | null;
	latestComparison: Comparison | null;
	verdict: Verdict | null;
}

export interface PullRequestReport {
	pullRequest: PullRequest;
	commits: { position: number; sha: string; isBase: boolean }[];
	statistic: Statistic;
	threshold: number;
	includeDirty: boolean;
	machineId: number | null;
	machines: { machineId: number; count: number }[];
	series: SeriesReport[];
	summary: Record<Verdict, number> & { series: number; missingReference: number; crossRun: number };
}

export function verdictFor(ratio: number, low: number, high: number, threshold: number): Exclude<Verdict, "failed"> {
	if (low > 1 && ratio > 1 + threshold) return "regression";
	if (high < 1 && ratio < 1 - threshold) return "improvement";
	if (Math.abs(ratio - 1) <= threshold && low >= 1 - 2 * threshold && high <= 1 + 2 * threshold) return "unchanged";
	return "inconclusive";
}

const comparisonCache = new Map<string, { ratio: number; low: number; high: number; resamples: number } | null>();

export function compare(
	store: Store, candidate: Measurement, baseline: Measurement, statistic: Statistic, threshold: number,
	times: (measurement: Measurement) => number[] = (measurement) => store.times(measurement.id),
): Comparison | null {
	const key = `${candidate.id}:${baseline.id}:${statistic}`;
	let interval = comparisonCache.get(key);
	if (interval === undefined) {
		interval = bootstrapRatio(times(candidate), times(baseline), statistic, seedFrom(key));
		if (comparisonCache.size > 20_000) comparisonCache.clear();
		comparisonCache.set(key, interval);
	}
	if (!interval) return null;
	const failed = candidate.status === "failed" || baseline.status === "failed";
	return {
		candidate, baseline, statistic, ...interval,
		verdict: failed ? "failed" : verdictFor(interval.ratio, interval.low, interval.high, threshold),
		sameRun: candidate.runId === baseline.runId,
	};
}

/** Representative measurement: working builds first, then clean trees, then most recent. */
function rank(a: Measurement, b: Measurement): number {
	const failed = Number(a.status === "failed") - Number(b.status === "failed");
	if (failed) return failed;
	const dirtiness = (value: boolean | null) => value === true ? 2 : value === null ? 1 : 0;
	const dirty = dirtiness(a.dirty) - dirtiness(b.dirty);
	if (dirty) return dirty;
	return b.recordedAt.localeCompare(a.recordedAt) || b.id - a.id;
}

/** Prefers a pair measured in one Hyperfine run, which cancels session-to-session drift. */
function pair(candidates: Measurement[], references: Measurement[]): [Measurement, Measurement] | null {
	if (!candidates.length || !references.length) return null;
	for (const candidate of candidates) {
		if (candidate.status === "failed") continue;
		const match = references.find((reference) => reference.runId === candidate.runId && reference.status !== "failed");
		if (match) return [candidate, match];
	}
	return [candidates[0], references[0]];
}

export function pullRequestReport(store: Store, pullRequestId: number, options: ReportOptions = {}): PullRequestReport {
	const pullRequest = store.pullRequest(pullRequestId);
	if (!pullRequest) throw new Error(`Unknown pull request ${pullRequestId}.`);
	const statistic = options.statistic ?? "median";
	const threshold = options.threshold ?? 0.02;
	const includeDirty = options.includeDirty ?? false;
	const commits = [
		...(pullRequest.baseSha ? [{ position: 0, sha: pullRequest.baseSha, isBase: true }] : []),
		...store.pullRequestCommits(pullRequestId).map((commit, index) => ({ position: index + 1, sha: commit.sha, isBase: false })),
	];
	const all = store.measurementsForCommits(pullRequest.repositoryId, commits.map((commit) => commit.sha))
		.filter((measurement) => includeDirty || measurement.dirty !== true);
	const counts = new Map<number, number>();
	for (const measurement of all) counts.set(measurement.machineId, (counts.get(measurement.machineId) ?? 0) + 1);
	const machines = [...counts].map(([machineId, count]) => ({ machineId, count })).sort((a, b) => b.count - a.count);
	const machineId = options.machineId ?? machines[0]?.machineId ?? null;
	const selected = all.filter((measurement) => measurement.machineId === machineId);

	const timesCache = new Map<number, number[]>();
	const times = (measurement: Measurement) => {
		let value = timesCache.get(measurement.id);
		if (!value) timesCache.set(measurement.id, value = store.times(measurement.id));
		return value;
	};
	const groups = new Map<string, Measurement[]>();
	for (const measurement of selected) {
		const key = `${measurement.benchmarkId}\0${measurement.caseKey}`;
		groups.set(key, [...groups.get(key) ?? [], measurement]);
	}
	const comparison = (candidates: Measurement[], references: Measurement[]) => {
		const chosen = pair(candidates, references);
		return chosen ? compare(store, chosen[0], chosen[1], statistic, threshold, times) : null;
	};

	const series = [...groups.values()].map((measurements): SeriesReport => {
		const points: ReportPoint[] = commits.map((commit) => {
			const candidates = measurements.filter((measurement) => measurement.commitSha === commit.sha).sort(rank);
			return { ...commit, measurement: candidates[0] ?? null, candidates, vsReference: null, vsPrevious: null };
		});
		const measured = points.filter((point) => point.measurement);
		const reference = measured[0] ?? null;
		let previous: ReportPoint | null = null;
		for (const point of measured) {
			if (reference && point !== reference) point.vsReference = comparison(point.candidates, reference.candidates);
			if (previous) point.vsPrevious = comparison(point.candidates, previous.candidates);
			previous = point;
		}
		const latest = measured.at(-1) ?? null;
		const latestComparison = latest && latest !== reference ? latest.vsReference : null;
		const first = measurements[0];
		return {
			benchmarkId: first.benchmarkId, caseKey: first.caseKey,
			label: measurements.at(-1)!.label, points, reference, referenceIsBase: reference?.isBase ?? false,
			latest, latestComparison, verdict: latestComparison?.verdict ?? null,
		};
	}).sort((a, b) => a.benchmarkId - b.benchmarkId || a.caseKey.localeCompare(b.caseKey));

	const summary = {
		regression: 0, improvement: 0, unchanged: 0, inconclusive: 0, failed: 0,
		series: series.length, missingReference: 0, crossRun: 0,
	};
	for (const entry of series) {
		if (entry.verdict) summary[entry.verdict]++;
		if (!entry.referenceIsBase) summary.missingReference++;
		if (entry.latestComparison && !entry.latestComparison.sameRun) summary.crossRun++;
	}
	return { pullRequest, commits, statistic, threshold, includeDirty, machineId, machines, series, summary };
}
