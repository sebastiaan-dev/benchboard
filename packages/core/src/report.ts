import { bootstrapRatio, seedFrom, type Statistic } from "./stats.ts";
import type { Measurement, PullRequest, Store } from "./store.ts";

/** `insufficient`: too few samples on a side to estimate variability; only the descriptive ratio is shown. */
export type Verdict = "regression" | "improvement" | "unchanged" | "inconclusive" | "failed" | "insufficient";

/** Minimum samples per side for an interval; below this a comparison is descriptive only. */
export const MIN_SAMPLES = 3;

/**
 * How the two sides of a comparison were chosen. The candidate is always the commit's representative
 * (passing, clean, most recent). `same-invocation`: the baseline comes from the same Hyperfine invocation
 * (shared session conditions; Hyperfine runs commands in blocks, so it is not interleaved).
 * `representatives`: no shared invocation, so the baseline is that commit's own representative.
 */
export type Pairing = "same-invocation" | "representatives";

export interface Comparison {
	/** The measurements actually compared; every figure shown for this comparison must come from these. */
	candidate: Measurement;
	baseline: Measurement;
	statistic: Statistic;
	/** statistic(candidate) / statistic(baseline); above 1 is slower. */
	ratio: number;
	/** Percentile-bootstrap 95% interval; null when either side has fewer than MIN_SAMPLES samples. */
	low: number | null;
	high: number | null;
	resamples: number;
	verdict: Verdict;
	/** Both sides were measured in the same Hyperfine invocation. */
	sameRun: boolean;
	pairing: Pairing;
	/** Eligible measurements at the two commits that were not used (other runs). */
	alternatives: number;
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
	/** Representative measurement: the candidate of every comparison at this commit. */
	measurement: Measurement | null;
	candidates: Measurement[];
	vsReference: Comparison | null;
	vsPrevious: Comparison | null;
	/** Position of the previous measured commit (the other side of vsPrevious). */
	previousPosition: number | null;
	/** The step spans unmeasured commits, so it cannot be attributed to this commit alone. */
	spansGap: boolean;
}

export interface SeriesReport {
	benchmarkId: number;
	caseKey: string;
	label: string;
	points: ReportPoint[];
	reference: ReportPoint | null;
	referenceIsBase: boolean;
	/** The PR head commit's point, if this series was measured there. */
	head: ReportPoint | null;
	headComparison: Comparison | null;
	/** Last measured commit (may precede the head). */
	latest: ReportPoint | null;
	latestComparison: Comparison | null;
	/** Verdict of the head comparison; null when the head (or a second commit) was not measured. */
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
	summary: Record<Verdict, number> & { series: number; missingReference: number; missingHead: number; crossRun: number };
}

export function verdictFor(ratio: number, low: number, high: number, threshold: number): Exclude<Verdict, "failed" | "insufficient"> {
	if (low > 1 && ratio > 1 + threshold) return "regression";
	if (high < 1 && ratio < 1 - threshold) return "improvement";
	if (Math.abs(ratio - 1) <= threshold && low >= 1 - 2 * threshold && high <= 1 + 2 * threshold) return "unchanged";
	return "inconclusive";
}

/** Stable identity of a stored measurement: run IDs are random and never reused, unlike SQLite row IDs. */
const identity = (measurement: Measurement) => `${measurement.runId}#${measurement.position}`;

export function compare(
	store: Store, candidate: Measurement, baseline: Measurement, statistic: Statistic, threshold: number,
	times: (measurement: Measurement) => number[] = (measurement) => store.times(measurement.id),
	context: { pairing?: Pairing; alternatives?: number } = {},
): Comparison | null {
	const key = `${identity(candidate)}:${identity(baseline)}:${statistic}`;
	const enough = candidate.n >= MIN_SAMPLES && baseline.n >= MIN_SAMPLES;
	// Cached per store and dropped on every write, so deleted or replaced data never resurfaces.
	const interval = store.cached(`compare:${key}`, () => bootstrapRatio(times(candidate), times(baseline), statistic, seedFrom(key)));
	if (!interval) return null;
	const failed = candidate.status === "failed" || baseline.status === "failed";
	return {
		candidate, baseline, statistic, ratio: interval.ratio,
		low: enough ? interval.low : null, high: enough ? interval.high : null, resamples: enough ? interval.resamples : 0,
		verdict: failed ? "failed" : !enough ? "insufficient" : verdictFor(interval.ratio, interval.low, interval.high, threshold),
		sameRun: candidate.runId === baseline.runId,
		pairing: context.pairing ?? (candidate.runId === baseline.runId ? "same-invocation" : "representatives"),
		alternatives: context.alternatives ?? 0,
	};
}

const dirtiness = (value: boolean | null) => value === true ? 2 : value === null ? 1 : 0;

/** Representative measurement: working builds first, then clean trees, then most recent. */
function rank(a: Measurement, b: Measurement): number {
	const failed = Number(a.status === "failed") - Number(b.status === "failed");
	if (failed) return failed;
	const dirty = dirtiness(a.dirty) - dirtiness(b.dirty);
	if (dirty) return dirty;
	return b.recordedAt.localeCompare(a.recordedAt) || b.id - a.id;
}

/**
 * The candidate is the commit's representative. The baseline is taken from the same invocation when
 * the reference commit has an equally eligible measurement there (same cleanliness, passing);
 * otherwise it is the reference commit's own representative. Same-invocation pairing therefore never
 * overrides recency or clean-build eligibility.
 */
function pair(candidates: Measurement[], references: Measurement[]): { candidate: Measurement; baseline: Measurement; pairing: Pairing; alternatives: number } | null {
	const candidate = candidates[0];
	const representative = references[0];
	if (!candidate || !representative) return null;
	const sameInvocation = references.find((reference) => reference.runId === candidate.runId &&
		reference.status !== "failed" && dirtiness(reference.dirty) === dirtiness(representative.dirty));
	const baseline = sameInvocation ?? representative;
	return {
		candidate, baseline, pairing: sameInvocation ? "same-invocation" : "representatives",
		alternatives: candidates.length - 1 + references.length - 1,
	};
}

export function pullRequestReport(store: Store, pullRequestId: number, options: ReportOptions = {}): PullRequestReport {
	const statistic = options.statistic ?? "median";
	const threshold = options.threshold ?? 0.02;
	const includeDirty = options.includeDirty ?? false;
	const key = `report:${pullRequestId}:${statistic}:${threshold}:${includeDirty}:${options.machineId ?? "auto"}`;
	return store.cached(key, () => buildReport(store, pullRequestId, { statistic, threshold, includeDirty, machineId: options.machineId ?? null }));
}

function buildReport(store: Store, pullRequestId: number, options: Required<ReportOptions>): PullRequestReport {
	const pullRequest = store.pullRequest(pullRequestId);
	if (!pullRequest) throw new Error(`Unknown pull request ${pullRequestId}.`);
	const { statistic, threshold, includeDirty } = options;
	const commits = [
		...(pullRequest.baseSha ? [{ position: 0, sha: pullRequest.baseSha, isBase: true }] : []),
		...store.pullRequestCommits(pullRequestId).map((commit, index) => ({ position: index + 1, sha: commit.sha, isBase: false })),
	];
	const headPosition = commits.at(-1)?.isBase === false ? commits.at(-1)!.position : null;
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
		return chosen ? compare(store, chosen.candidate, chosen.baseline, statistic, threshold, times, chosen) : null;
	};

	const series = [...groups.values()].map((measurements): SeriesReport => {
		const points: ReportPoint[] = commits.map((commit) => {
			const candidates = measurements.filter((measurement) => measurement.commitSha === commit.sha).sort(rank);
			return { ...commit, measurement: candidates[0] ?? null, candidates, vsReference: null, vsPrevious: null, previousPosition: null, spansGap: false };
		});
		const measured = points.filter((point) => point.measurement);
		const reference = measured[0] ?? null;
		let previous: ReportPoint | null = null;
		for (const point of measured) {
			if (reference && point !== reference) point.vsReference = comparison(point.candidates, reference.candidates);
			if (previous) {
				point.vsPrevious = comparison(point.candidates, previous.candidates);
				point.previousPosition = previous.position;
				point.spansGap = point.position - previous.position > 1;
			}
			previous = point;
		}
		const latest = measured.at(-1) ?? null;
		const head = headPosition === null ? null : points.find((point) => point.position === headPosition && point.measurement) ?? null;
		const headComparison = head && head !== reference ? head.vsReference : null;
		const first = measurements[0];
		return {
			benchmarkId: first.benchmarkId, caseKey: first.caseKey,
			label: measurements.at(-1)!.label, points, reference, referenceIsBase: reference?.isBase ?? false,
			head, headComparison, latest, latestComparison: latest && latest !== reference ? latest.vsReference : null,
			verdict: headComparison?.verdict ?? null,
		};
	}).sort((a, b) => a.benchmarkId - b.benchmarkId || a.caseKey.localeCompare(b.caseKey));

	const summary = {
		regression: 0, improvement: 0, unchanged: 0, inconclusive: 0, failed: 0, insufficient: 0,
		series: series.length, missingReference: 0, missingHead: 0, crossRun: 0,
	};
	for (const entry of series) {
		if (entry.verdict) summary[entry.verdict]++;
		if (!entry.referenceIsBase) summary.missingReference++;
		if (!entry.head) summary.missingHead++;
		if (entry.headComparison && !entry.headComparison.sameRun) summary.crossRun++;
	}
	return { pullRequest, commits, statistic, threshold, includeDirty, machineId, machines, series, summary };
}
