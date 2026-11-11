import { readFileSync } from "node:fs";
import { makeExecutableSchema } from "@graphql-tools/schema";
import { GraphQLScalarType, Kind, type GraphQLSchema, type ValueNode } from "graphql";
import {
	compare, diffFunctions, functionStats, metricTotal, pullRequestReport, type Comparison, type Metric, type Profile,
} from "@benchboard/core";
import { createContext, type Context } from "./context.ts";
import type { Resolvers } from "./generated/resolvers.ts";
import type { CaseParent, PointParent, SeriesParent } from "./mappers.ts";

export { createContext, type Context };

export const typeDefs = readFileSync(new URL("../schema.graphql", import.meta.url), "utf8");

function authorize(context: Context) {
	if (!context.mayMutate) {
		throw new Error("Mutations require the server session token (sent automatically by the Benchboard web app).");
	}
}

const id = (value: unknown): number => {
	const number = Number(value);
	if (!Number.isSafeInteger(number)) throw new Error(`Invalid ID: ${String(value)}`);
	return number;
};
const bounded = (value: number | null | undefined, fallback: number, max: number) => Math.min(Math.max(value ?? fallback, 1), max);
const optional = <T>(value: T | null | undefined) => value ?? undefined;

function literal(node: ValueNode): unknown {
	switch (node.kind) {
		case Kind.STRING: case Kind.BOOLEAN: return node.value;
		case Kind.INT: case Kind.FLOAT: return Number(node.value);
		case Kind.LIST: return node.values.map(literal);
		case Kind.OBJECT: return Object.fromEntries(node.fields.map((field) => [field.name.value, literal(field.value)]));
		default: return null;
	}
}

const JSONScalar = new GraphQLScalarType({
	name: "JSON", serialize: (value) => value, parseValue: (value) => value, parseLiteral: literal,
});

const perIteration = (profile: Profile, metric: Metric) => (metric === "cpu" ? profile.cpuMs : profile.sampledMs) / profile.iterations;
const present = <T>(value: T | undefined, what: string): T => {
	if (value === undefined) throw new Error(`${what} no longer exists.`);
	return value;
};

export const resolvers: Resolvers = {
	JSON: JSONScalar,
	Query: {
		repositories: (_, __, { store }) => store.repositories(),
		repository: (_, args, { store }) =>
			(args.id !== undefined && args.id !== null ? store.repository(id(args.id)) : args.slug ? store.repositoryBySlug(args.slug) : undefined) ?? null,
		pullRequest: (_, args, { store }) => store.pullRequest(id(args.id)) ?? null,
		run: (_, args, { loaders }) => loaders.run(String(args.id)) ?? null,
		measurement: (_, args, { store }) => store.measurement(id(args.id)) ?? null,
		measurements: (_, args, { store }) => {
			if (args.ids.length > 1000) throw new Error("Request at most 1000 measurements at once.");
			return args.ids.flatMap((value) => store.measurement(id(value)) ?? []);
		},
		benchmark: (_, args, { loaders }) => loaders.benchmark(id(args.id)) ?? null,
		machine: (_, args, { loaders }) => loaders.machine(id(args.id)) ?? null,
		runs: (_, args, { store, loaders }) => loaders.primeRuns(store.runs({ limit: optional(args.limit), offset: optional(args.offset) })),
		profile: (_, args, { store }) => store.profile(id(args.id)) ?? null,
		profileDiff: (_, args, { store }) => {
			const base = store.profile(id(args.base));
			const head = store.profile(id(args.head));
			if (!base || !head) throw new Error("Unknown profile.");
			const metric = args.metric ?? "cpu";
			const functions = diffFunctions(store.profileTree(base.id), store.profileTree(head.id), { metric, iterations: { base: base.iterations, head: head.iterations } })
				.slice(0, bounded(args.limit, 200, 5000))
				.map((entry) => ({ ...entry, deltaSelfMs: entry.headSelfMs - entry.baseSelfMs, deltaTotalMs: entry.headTotalMs - entry.baseTotalMs }));
			return { base, head, metric, baseMs: perIteration(base, metric), headMs: perIteration(head, metric), functions };
		},
	},
	Mutation: {
		syncPullRequest: (_, args, context) => {
			authorize(context);
			return context.store.resyncPullRequest(id(args.id));
		},
		trackGithubPullRequest: (_, args, context) => {
			authorize(context);
			return context.store.syncGithubPullRequest({ repositoryId: id(args.repository), reference: args.reference });
		},
		deleteRun: (_, args, context) => {
			authorize(context);
			return context.store.deleteRun(String(args.id));
		},
		deleteProfile: (_, args, context) => {
			authorize(context);
			return context.store.deleteProfile(id(args.id));
		},
	},
	ProfileSort: { SELF: "self", TOTAL: "total" },
	ProfileMetric: { CPU: "cpu", SAMPLED: "sampled" },
	CpuSource: { THREAD_CPU_DELTA: "thread-cpu-delta", SAMPLE_COUNT: "sample-count" },
	PullRequestSource: { GITHUB: "github", LOCAL: "local" },
	Statistic: { MEDIAN: "median", MEAN: "mean" },
	Verdict: {
		REGRESSION: "regression", IMPROVEMENT: "improvement", UNCHANGED: "unchanged", INCONCLUSIVE: "inconclusive",
		FAILED: "failed", INSUFFICIENT: "insufficient",
	},
	Pairing: { SAME_INVOCATION: "same-invocation", REPRESENTATIVES: "representatives" },
	MeasurementStatus: { PASSED: "passed", FAILED: "failed", UNVERIFIED: "unverified" },
	Profile: {
		id: (profile) => String(profile.id),
		measurement: (profile, _, { store }) => present(store.measurement(profile.measurementId), "The profiled measurement"),
		cpuMs: (profile) => perIteration(profile, "cpu"),
		sampledMs: (profile) => perIteration(profile, "sampled"),
		threads: (profile) => profile.threads.map((thread) => ({
			...thread, cpuMs: (thread.cpuMs ?? 0) / profile.iterations, sampledMs: (thread.sampledMs ?? 0) / profile.iterations,
		})),
		hasSymbols: (profile) => profile.symsSha256 !== null,
		rawPath: (profile) => `/profiles/${profile.id}/profile.json.gz`,
		firefoxProfilerUrl: (profile, args) => {
			const origin = args.origin.replace(/\/+$/, "");
			if (!/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin)) throw new Error("origin must be a local http(s) URL.");
			const raw = encodeURIComponent(`${origin}/profiles/${profile.id}/profile.json.gz`);
			const symbols = encodeURIComponent(`${origin}/profiles/${profile.id}/symbols`);
			return `https://profiler.firefox.com/from-url/${raw}/calltree/?symbolServer=${symbols}`;
		},
		tree: (profile, _, { store }) => store.profileTree(profile.id),
		related: (profile, _, { store }) => {
			const measurement = store.measurement(profile.measurementId);
			if (!measurement) return [];
			return store.profilesForSeries(measurement.benchmarkId, measurement.caseKey).filter((entry) => entry.id !== profile.id);
		},
		topFunctions: (profile, args, { store }) => {
			const tree = store.profileTree(profile.id);
			const metric = args.metric ?? "cpu";
			const scale = 1 / profile.iterations;
			const total = metricTotal(tree, metric) || 1;
			const key = args.by === "total" ? "total" : "self";
			return functionStats(tree, metric).sort((a, b) => b[key] - a[key]).slice(0, bounded(args.limit, 50, 1000)).map((stat) => ({
				name: stat.name, library: stat.library, selfMs: stat.self * scale, totalMs: stat.total * scale,
				selfShare: stat.self / total, totalShare: stat.total / total,
			}));
		},
	},
	Repository: {
		id: (repository) => String(repository.id),
		pullRequests: (repository, _, { store }) => store.pullRequests(repository.id),
		benchmarks: (repository, _, { store }) => store.benchmarks(repository.id),
		runs: (repository, args, { store, loaders }) => loaders.primeRuns(
			store.runs({ repositoryId: repository.id, limit: optional(args.limit), offset: optional(args.offset), search: optional(args.search) })),
		runCount: (repository, args, { store }) => store.runCount({ repositoryId: repository.id, search: optional(args.search) }),
		profiles: (repository, args, { store }) =>
			store.profilesForRepository(repository.id, { limit: optional(args.limit), offset: optional(args.offset), search: optional(args.search) }),
		profileCount: (repository, args, { store }) => store.profileCount(repository.id, optional(args.search)),
		commit: (repository, args, { store }) => {
			const exact = store.commit(repository.id, args.sha.toLowerCase());
			if (exact) return exact;
			const matches = store.commitsByPrefix(repository.id, args.sha);
			return matches.length === 1 ? matches[0] : null;
		},
	},
	Commit: {
		shortSha: (commit) => commit.sha.slice(0, 10),
		url: (commit, _, { loaders }) => {
			const github = loaders.repository(commit.repositoryId)?.githubRepo;
			return github ? `https://github.com/${github}/commit/${commit.sha}` : null;
		},
		measurements: (commit, _, { store }) => store.measurementsForCommits(commit.repositoryId, [commit.sha]),
		pullRequests: (commit, _, { store }) => store.pullRequestsForCommit(commit.repositoryId, commit.sha),
	},
	PullRequest: {
		id: (pr) => String(pr.id),
		repository: (pr, _, { loaders }) => present(loaders.repository(pr.repositoryId), "The repository"),
		baseCommit: (pr, _, { loaders }) => pr.baseSha ? loaders.commit(pr.repositoryId, pr.baseSha) : null,
		commits: (pr, _, { store }) => store.pullRequestCommits(pr.id),
		report: (pr, args, { store }) => ({
			// Reports are cached in the store per data version, so navigation summaries stay cheap.
			...pullRequestReport(store, pr.id, {
				statistic: optional(args.statistic), includeDirty: optional(args.includeDirty), threshold: optional(args.threshold),
				machineId: args.machine === undefined || args.machine === null ? null : id(args.machine),
			}),
			repositoryId: pr.repositoryId,
		}),
	},
	PullRequestReport: {
		machine: (report, _, { loaders }) => report.machineId === null ? null : loaders.machine(report.machineId) ?? null,
		machines: (report, _, { loaders }) => report.machines.flatMap((entry) => {
			const machine = loaders.machine(entry.machineId);
			return machine ? [{ machine, count: entry.count }] : [];
		}),
		commits: (report, _, { loaders }) => report.commits.map((entry) => ({
			position: entry.position, isBase: entry.isBase, commit: loaders.commit(report.repositoryId, entry.sha),
		})),
		series: (report): SeriesParent[] => report.series.map((series) => ({
			...series, repositoryId: report.repositoryId, pullRequestId: report.pullRequest.id,
		})),
		summary: (report) => ({
			series: report.summary.series, regressions: report.summary.regression, improvements: report.summary.improvement,
			unchanged: report.summary.unchanged, inconclusive: report.summary.inconclusive, failed: report.summary.failed,
			insufficient: report.summary.insufficient, missingReference: report.summary.missingReference,
			missingHead: report.summary.missingHead, crossRun: report.summary.crossRun,
		}),
	},
	SeriesReport: {
		id: (series) => `${series.pullRequestId}:${series.benchmarkId}:${series.caseKey}`,
		benchmark: (series, _, { loaders }) => present(loaders.benchmark(series.benchmarkId), "The benchmark"),
		points: (series): PointParent[] => series.points.map((point) => ({ ...point, repositoryId: series.repositoryId })),
		reference: (series) => series.reference && { ...series.reference, repositoryId: series.repositoryId },
		latest: (series) => series.latest && { ...series.latest, repositoryId: series.repositoryId },
		head: (series) => series.head && { ...series.head, repositoryId: series.repositoryId },
	},
	ReportPoint: {
		commit: (point, _, { loaders }) => loaders.commit(point.repositoryId, point.sha),
	},
	Comparison: {
		changePercent: (comparison) => (comparison.ratio - 1) * 100,
	},
	Benchmark: {
		id: (benchmark) => String(benchmark.id),
		repository: (benchmark, _, { loaders }) => present(loaders.repository(benchmark.repositoryId), "The repository"),
		cases: (benchmark, _, { loaders }): CaseParent[] => loaders.benchmarkCases(benchmark.repositoryId, benchmark.id)
			.map((entry) => ({ ...entry, benchmarkId: benchmark.id, repositoryId: benchmark.repositoryId })),
		runs: (benchmark, args, { store, loaders }) =>
			loaders.primeRuns(store.runs({ benchmarkId: benchmark.id, limit: optional(args.limit), offset: optional(args.offset) })),
	},
	BenchmarkCase: {
		measurements: (entry, args, { loaders }) =>
			loaders.seriesMeasurements(entry.repositoryId, entry.benchmarkId, entry.caseKey, bounded(args.limit, 500, 5000)),
	},
	Machine: {
		id: (machine) => String(machine.id),
	},
	Run: {
		repository: (run, _, { loaders }) => present(loaders.repository(run.repositoryId), "The repository"),
		machine: (run, _, { loaders }) => present(loaders.machine(run.machineId), "The machine"),
		exportPath: (run, _, { store }) => store.exportPath(run.exportSha256),
		measurements: (run, _, { loaders }) => loaders.runMeasurements(run.id),
		pairedComparisons: (run, args, { store, loaders }) => {
			const first = new Map<string, (typeof measurements)[number]>();
			const measurements = loaders.runMeasurements(run.id);
			const comparisons: Comparison[] = [];
			for (const measurement of measurements) {
				const key = `${measurement.benchmarkId}\0${measurement.caseKey}`;
				const reference = first.get(key);
				if (!reference) { first.set(key, measurement); continue; }
				const comparison = compare(store, measurement, reference, args.statistic ?? "median", args.threshold ?? 0.02);
				if (comparison) comparisons.push(comparison);
			}
			return comparisons;
		},
	},
	Measurement: {
		id: (measurement) => String(measurement.id),
		run: (measurement, _, { loaders }) => present(loaders.run(measurement.runId), "The run"),
		benchmark: (measurement, _, { loaders }) => present(loaders.benchmark(measurement.benchmarkId), "The benchmark"),
		commit: (measurement, _, { loaders }) => {
			if (!measurement.commitSha) return null;
			const run = loaders.run(measurement.runId);
			return run ? loaders.commit(run.repositoryId, measurement.commitSha) : null;
		},
		parameters: (measurement) => measurement.parameters &&
			Object.entries(measurement.parameters).map(([name, value]) => ({ name, value })),
		times: (measurement, _, { store }) => store.times(measurement.id),
		exitCodes: (measurement, _, { store }) => store.exitCodes(measurement.id),
		profiles: (measurement, _, { loaders }) => loaders.profiles(measurement.id),
		compare: (measurement, args, { store }) => {
			const baseline = store.measurement(id(args.baseline));
			if (!baseline) throw new Error(`Unknown measurement ${args.baseline}.`);
			return compare(store, measurement, baseline, args.statistic ?? "median", args.threshold ?? 0.02);
		},
	},
};

export function createSchema(): GraphQLSchema {
	return makeExecutableSchema({ typeDefs, resolvers });
}
