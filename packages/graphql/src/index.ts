import { readFileSync } from "node:fs";
import { makeExecutableSchema } from "@graphql-tools/schema";
import type { GraphQLSchema } from "graphql";
import {
	compare, pullRequestReport, type Commit, type Comparison, type Measurement, type PullRequest, type PullRequestReport,
	type ReportPoint, type Repository, type Run, type SeriesReport, type Store,
} from "@benchboard/core";

export const typeDefs = readFileSync(new URL("../schema.graphql", import.meta.url), "utf8");

export interface Context {
	store: Store;
}

type Args = Record<string, any>;
const id = (value: unknown): number => {
	const number = Number(value);
	if (!Number.isSafeInteger(number)) throw new Error(`Invalid ID: ${String(value)}`);
	return number;
};

/** Commit rows are optional (e.g. a SHA recorded without local git); fall back to a bare commit. */
function commitOf(store: Store, repositoryId: number, sha: string): Commit {
	return store.commit(repositoryId, sha) ?? {
		repositoryId, sha, parents: [], subject: null, author: null, authoredAt: null, committedAt: null,
	};
}

interface ReportParent extends PullRequestReport {
	repositoryId: number;
}
interface SeriesParent extends SeriesReport {
	repositoryId: number;
	pullRequestId: number;
}
interface PointParent extends ReportPoint {
	repositoryId: number;
}

export const resolvers = {
	Query: {
		repositories: (_: unknown, __: Args, { store }: Context) => store.repositories(),
		repository: (_: unknown, args: Args, { store }: Context) =>
			args.id !== undefined && args.id !== null ? store.repository(id(args.id)) : args.slug ? store.repositoryBySlug(args.slug) : null,
		pullRequest: (_: unknown, args: Args, { store }: Context) => store.pullRequest(id(args.id)),
		run: (_: unknown, args: Args, { store }: Context) => store.run(String(args.id)),
		measurement: (_: unknown, args: Args, { store }: Context) => store.measurement(id(args.id)),
		measurements: (_: unknown, args: Args, { store }: Context) => {
			if (args.ids.length > 1000) throw new Error("Request at most 1000 measurements at once.");
			return (args.ids as unknown[]).map((value) => store.measurement(id(value))).filter(Boolean);
		},
		benchmark: (_: unknown, args: Args, { store }: Context) => store.benchmark(id(args.id)),
		machine: (_: unknown, args: Args, { store }: Context) => store.machine(id(args.id)),
		runs: (_: unknown, args: Args, { store }: Context) => store.runs({ limit: args.limit, offset: args.offset }),
	},
	Mutation: {
		syncPullRequest: (_: unknown, args: Args, { store }: Context) => store.resyncPullRequest(id(args.id)),
		trackGithubPullRequest: (_: unknown, args: Args, { store }: Context) =>
			store.syncGithubPullRequest({ repositoryId: id(args.repository), reference: args.reference }),
		deleteRun: (_: unknown, args: Args, { store }: Context) => store.deleteRun(String(args.id)),
	},
	Repository: {
		pullRequests: (repository: Repository, _: Args, { store }: Context) => store.pullRequests(repository.id),
		benchmarks: (repository: Repository, _: Args, { store }: Context) => store.benchmarks(repository.id),
		runs: (repository: Repository, args: Args, { store }: Context) =>
			store.runs({ repositoryId: repository.id, limit: args.limit, offset: args.offset }),
		runCount: (repository: Repository, _: Args, { store }: Context) => store.runCount(repository.id),
		commit: (repository: Repository, args: Args, { store }: Context) => {
			const exact = store.commit(repository.id, String(args.sha).toLowerCase());
			if (exact) return exact;
			const matches = store.commitsByPrefix(repository.id, args.sha);
			return matches.length === 1 ? matches[0] : null;
		},
	},
	Commit: {
		shortSha: (commit: Commit) => commit.sha.slice(0, 10),
		url: (commit: Commit, _: Args, { store }: Context) => {
			const github = store.repository(commit.repositoryId)?.githubRepo;
			return github ? `https://github.com/${github}/commit/${commit.sha}` : null;
		},
		measurements: (commit: Commit, _: Args, { store }: Context) => store.measurementsForCommits(commit.repositoryId, [commit.sha]),
		pullRequests: (commit: Commit, _: Args, { store }: Context) => store.pullRequestsForCommit(commit.repositoryId, commit.sha),
	},
	PullRequestSource: { GITHUB: "github", LOCAL: "local" },
	Statistic: { MEDIAN: "median", MEAN: "mean" },
	Verdict: { REGRESSION: "regression", IMPROVEMENT: "improvement", UNCHANGED: "unchanged", INCONCLUSIVE: "inconclusive", FAILED: "failed" },
	MeasurementStatus: { PASSED: "passed", FAILED: "failed", UNVERIFIED: "unverified" },
	PullRequest: {
		repository: (pr: PullRequest, _: Args, { store }: Context) => store.repository(pr.repositoryId),
		baseCommit: (pr: PullRequest, _: Args, { store }: Context) => pr.baseSha ? commitOf(store, pr.repositoryId, pr.baseSha) : null,
		commits: (pr: PullRequest, _: Args, { store }: Context) => store.pullRequestCommits(pr.id),
		report: (pr: PullRequest, args: Args, { store }: Context): ReportParent => ({
			...pullRequestReport(store, pr.id, {
				statistic: args.statistic, includeDirty: args.includeDirty, threshold: args.threshold,
				machineId: args.machine === undefined || args.machine === null ? null : id(args.machine),
			}),
			repositoryId: pr.repositoryId,
		}),
	},
	PullRequestReport: {
		machine: (report: ReportParent, _: Args, { store }: Context) => report.machineId === null ? null : store.machine(report.machineId),
		machines: (report: ReportParent, _: Args, { store }: Context) =>
			report.machines.map((entry) => ({ machine: store.machine(entry.machineId), count: entry.count })),
		commits: (report: ReportParent, _: Args, { store }: Context) => report.commits.map((entry) => ({
			position: entry.position, isBase: entry.isBase, commit: commitOf(store, report.repositoryId, entry.sha),
		})),
		series: (report: ReportParent): SeriesParent[] => report.series.map((series) => ({
			...series, repositoryId: report.repositoryId, pullRequestId: report.pullRequest.id,
		})),
		summary: (report: ReportParent) => ({
			series: report.summary.series, regressions: report.summary.regression, improvements: report.summary.improvement,
			unchanged: report.summary.unchanged, inconclusive: report.summary.inconclusive, failed: report.summary.failed,
			missingReference: report.summary.missingReference, crossRun: report.summary.crossRun,
		}),
	},
	SeriesReport: {
		id: (series: SeriesParent) => `${series.pullRequestId}:${series.benchmarkId}:${series.caseKey}`,
		benchmark: (series: SeriesParent, _: Args, { store }: Context) => store.benchmark(series.benchmarkId),
		points: (series: SeriesParent): PointParent[] => series.points.map((point) => ({ ...point, repositoryId: series.repositoryId })),
		reference: (series: SeriesParent) => series.reference && { ...series.reference, repositoryId: series.repositoryId },
		latest: (series: SeriesParent) => series.latest && { ...series.latest, repositoryId: series.repositoryId },
	},
	ReportPoint: {
		commit: (point: PointParent, _: Args, { store }: Context) => commitOf(store, point.repositoryId, point.sha),
	},
	Comparison: {
		changePercent: (comparison: Comparison) => (comparison.ratio - 1) * 100,
	},
	Benchmark: {
		repository: (benchmark: { repositoryId: number }, _: Args, { store }: Context) => store.repository(benchmark.repositoryId),
		cases: (benchmark: { id: number }, _: Args, { store }: Context) =>
			store.benchmarkCases(benchmark.id).map((entry) => ({ ...entry, benchmarkId: benchmark.id })),
		runs: (benchmark: { id: number }, args: Args, { store }: Context) =>
			store.runs({ benchmarkId: benchmark.id, limit: args.limit, offset: args.offset }),
	},
	BenchmarkCase: {
		measurements: (entry: { benchmarkId: number; caseKey: string }, args: Args, { store }: Context) =>
			store.seriesMeasurements(entry.benchmarkId, entry.caseKey, Math.min(args.limit ?? 500, 5000)),
	},
	Run: {
		repository: (run: Run, _: Args, { store }: Context) => store.repository(run.repositoryId),
		machine: (run: Run, _: Args, { store }: Context) => store.machine(run.machineId),
		exportPath: (run: Run, _: Args, { store }: Context) => store.exportPath(run.exportSha256),
		measurements: (run: Run, _: Args, { store }: Context) => store.runMeasurements(run.id),
		pairedComparisons: (run: Run, args: Args, { store }: Context) => {
			const first = new Map<string, Measurement>();
			const comparisons = [];
			for (const measurement of store.runMeasurements(run.id)) {
				const key = `${measurement.benchmarkId}\0${measurement.caseKey}`;
				const reference = first.get(key);
				if (!reference) { first.set(key, measurement); continue; }
				const comparison = compare(store, measurement, reference, args.statistic, args.threshold);
				if (comparison) comparisons.push(comparison);
			}
			return comparisons;
		},
	},
	Measurement: {
		run: (measurement: Measurement, _: Args, { store }: Context) => store.run(measurement.runId),
		benchmark: (measurement: Measurement, _: Args, { store }: Context) => store.benchmark(measurement.benchmarkId),
		commit: (measurement: Measurement, _: Args, { store }: Context) => {
			if (!measurement.commitSha) return null;
			const run = store.run(measurement.runId)!;
			return commitOf(store, run.repositoryId, measurement.commitSha);
		},
		parameters: (measurement: Measurement) => measurement.parameters &&
			Object.entries(measurement.parameters).map(([name, value]) => ({ name, value })),
		times: (measurement: Measurement, _: Args, { store }: Context) => store.times(measurement.id),
		exitCodes: (measurement: Measurement, _: Args, { store }: Context) => store.exitCodes(measurement.id),
		compare: (measurement: Measurement, args: Args, { store }: Context) => {
			const baseline = store.measurement(id(args.baseline));
			if (!baseline) throw new Error(`Unknown measurement ${args.baseline}.`);
			return compare(store, measurement, baseline, args.statistic, args.threshold);
		},
	},
};

export function createSchema(): GraphQLSchema {
	return makeExecutableSchema({ typeDefs, resolvers });
}
