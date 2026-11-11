/**
 * Everything the CLI does against stored data goes through a Backend: `LocalBackend` operates on a
 * data directory in-process, `RemoteBackend` (remote.ts) calls a server, whose API (api-routes.ts)
 * dispatches to a LocalBackend. Inputs are prepared client-side (files read, commits resolved), so
 * both paths store exactly the same values.
 */
import { graphql, type ExecutionResult } from "graphql";
import { z } from "zod";
import {
	SCHEMA_VERSION, diffFunctions, functionStats, parsePullRequestReference, pullRequestReport,
	type Benchmark, type Commit, type FunctionDelta, type FunctionStat, type IngestResult, type Machine, type Measurement,
	type Metric, type PreparedProfile, type PreparedRun, type Principal, type Profile, type PullRequest, type PullRequestReport,
	type PullRequestSnapshot, type ReportOptions, type Repository, type Run, type Store,
} from "@benchboard/core";
import { createContext, createSchema, type Links } from "@benchboard/graphql";

export const VERSION = "0.1.0";

export interface ReportBundle {
	report: PullRequestReport;
	/** What the report refers to by ID, so it can be printed without further lookups. */
	machines: Machine[];
	benchmarks: Benchmark[];
	commits: Commit[];
}
export interface ProfileDetail {
	profile: Profile;
	measurement: Measurement;
}
export interface TrackedPullRequest {
	pullRequest: PullRequest;
	commitCount: number;
}
export interface Identity {
	principal: Principal;
	version: string;
	schemaVersion: number;
}

export interface Backend {
	/** Base URL of the web app showing this data. */
	readonly webUrl: string;
	whoami(): Promise<Identity>;
	ingest(run: PreparedRun, options: { allowDuplicate?: boolean }): Promise<IngestResult>;
	savePullRequest(snapshot: PullRequestSnapshot): Promise<TrackedPullRequest>;
	/** `reference`: `id:<n>`, `owner/name#n`, a GitHub URL, or a number/branch within `repositorySlug`. */
	resolvePullRequest(repositorySlug: string | null, reference: string): Promise<PullRequest>;
	pullRequests(repositorySlug: string | null): Promise<PullRequest[]>;
	pullRequestReport(id: number, options: ReportOptions): Promise<ReportBundle>;
	repository(id: number): Promise<Repository | null>;
	repositoryBySlug(slug: string): Promise<Repository | null>;
	runs(repositorySlug: string | null, limit: number): Promise<Run[]>;
	measurement(reference: string): Promise<Measurement>;
	attachProfile(measurementId: number, profile: PreparedProfile): Promise<ProfileDetail>;
	profile(id: number): Promise<ProfileDetail>;
	profileFunctions(id: number, metric: Metric, limit: number): Promise<FunctionStat[]>;
	profileDiff(base: number, head: number, metric: Metric, limit: number): Promise<FunctionDelta[]>;
	legacyIds(): Promise<string[]>;
	query(source: string, variables?: Record<string, unknown>): Promise<ExecutionResult>;
}

const metric = z.enum(["cpu", "sampled"]);
const limit = z.number().int().min(1).max(10_000);
const positive = z.number().int().positive();

/** Remote-callable methods: the scope each needs and the shape of its arguments. */
export const METHODS = {
	whoami: { scope: "read", args: z.tuple([]) },
	ingest: { scope: "write", args: z.tuple([z.unknown(), z.object({ allowDuplicate: z.boolean().optional() }).strict()]) },
	savePullRequest: { scope: "write", args: z.tuple([z.unknown()]) },
	resolvePullRequest: { scope: "read", args: z.tuple([z.string().max(1024).nullable(), z.string().min(1).max(1024)]) },
	pullRequests: { scope: "read", args: z.tuple([z.string().max(1024).nullable()]) },
	pullRequestReport: {
		scope: "read",
		args: z.tuple([positive, z.object({
			statistic: z.enum(["median", "mean"]).optional(), includeDirty: z.boolean().optional(),
			machineId: positive.nullable().optional(), threshold: z.number().min(0).max(10).optional(),
		}).strict()]),
	},
	repository: { scope: "read", args: z.tuple([positive]) },
	repositoryBySlug: { scope: "read", args: z.tuple([z.string().min(1).max(1024)]) },
	runs: { scope: "read", args: z.tuple([z.string().max(1024).nullable(), limit]) },
	measurement: { scope: "read", args: z.tuple([z.string().min(1).max(256)]) },
	attachProfile: { scope: "write", args: z.tuple([positive, z.unknown()]) },
	profile: { scope: "read", args: z.tuple([positive]) },
	profileFunctions: { scope: "read", args: z.tuple([positive, metric, limit]) },
	profileDiff: { scope: "read", args: z.tuple([positive, positive, metric, limit]) },
	legacyIds: { scope: "read", args: z.tuple([]) },
} as const satisfies Record<string, { scope: Principal["scope"]; args: z.ZodType<unknown[]> }>;
export type MethodName = keyof typeof METHODS;

export class LocalBackend implements Backend {
	readonly store: Store;
	readonly webUrl: string;
	private readonly principal: Principal;
	private readonly links: Links | undefined;
	/** Inputs come from other machines: their checkout paths are not this host's. */
	private readonly remote: boolean;

	constructor(store: Store, options: { webUrl: string; principal?: Principal; links?: Links; remote?: boolean }) {
		this.store = store;
		this.webUrl = options.webUrl;
		this.principal = options.principal ?? { name: "local", scope: "admin", tokenId: null };
		this.links = options.links;
		this.remote = options.remote ?? false;
	}

	async whoami(): Promise<Identity> {
		return { principal: this.principal, version: VERSION, schemaVersion: SCHEMA_VERSION };
	}

	async ingest(run: PreparedRun, options: { allowDuplicate?: boolean }) {
		return this.store.ingestPrepared(run, { ...options, remote: this.remote });
	}

	async savePullRequest(snapshot: PullRequestSnapshot) {
		const pullRequest = this.store.savePullRequest(snapshot, { remote: this.remote });
		return { pullRequest, commitCount: this.store.pullRequestCommits(pullRequest.id).length };
	}

	async resolvePullRequest(repositorySlug: string | null, reference: string): Promise<PullRequest> {
		const store = this.store;
		const internal = /^id:(\d+)$/.exec(reference);
		if (internal) {
			const pr = store.pullRequest(Number(internal[1]));
			if (!pr) throw new Error(`No tracked pull request with id ${internal[1]}.`);
			return pr;
		}
		const url = /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(reference) ?? /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(reference);
		if (url) {
			const pr = store.pullRequests().find((entry) => entry.githubRepo === url[1] && entry.number === Number(url[2]));
			if (!pr) throw new Error(`${reference} is not tracked; run \`benchboard pr track ${reference}\`.`);
			return pr;
		}
		const pr = store.findPullRequest(this.requireRepository(repositorySlug).id, reference.replace(/^#/, ""));
		if (!pr) throw new Error(`No tracked pull request "${reference}" in this repository; run \`benchboard pr track\` first.`);
		return pr;
	}

	async pullRequests(repositorySlug: string | null) {
		return repositorySlug === null ? this.store.pullRequests() : this.store.pullRequests(this.requireRepository(repositorySlug).id);
	}

	async pullRequestReport(id: number, options: ReportOptions): Promise<ReportBundle> {
		const store = this.store;
		const report = pullRequestReport(store, id, options);
		const benchmarkIds = new Set(report.series.map((series) => series.benchmarkId));
		const shas = new Set(report.series.flatMap((series) => series.points.map((point) => point.sha)));
		return {
			report,
			machines: report.machines.map((entry) => store.machine(entry.machineId)).filter((machine) => machine !== undefined),
			benchmarks: [...benchmarkIds].map((benchmarkId) => store.benchmark(benchmarkId)!),
			commits: [...shas].map((sha) => store.commit(report.pullRequest.repositoryId, sha)).filter((commit) => commit !== undefined),
		};
	}

	async repository(id: number) {
		return this.store.repository(id) ?? null;
	}

	async repositoryBySlug(slug: string) {
		return this.store.repositoryBySlug(slug) ?? null;
	}

	async runs(repositorySlug: string | null, limit: number) {
		return this.store.runs({ repositoryId: repositorySlug === null ? undefined : this.requireRepository(repositorySlug).id, limit });
	}

	async measurement(reference: string) {
		return this.store.measurementByReference(reference);
	}

	async attachProfile(measurementId: number, profile: PreparedProfile) {
		return this.detail(this.store.attachPreparedProfile(measurementId, profile));
	}

	async profile(id: number) {
		return this.detail(this.requireProfile(id));
	}

	async profileFunctions(id: number, metric: Metric, limit: number) {
		const profile = this.requireProfile(id);
		const scale = 1 / profile.iterations;
		return functionStats(this.store.profileTree(id), metric).sort((a, b) => b.self - a.self).slice(0, limit)
			.map((stat) => ({ ...stat, self: stat.self * scale, total: stat.total * scale }));
	}

	async profileDiff(baseId: number, headId: number, metric: Metric, limit: number) {
		const [base, head] = [this.requireProfile(baseId), this.requireProfile(headId)];
		return diffFunctions(this.store.profileTree(base.id), this.store.profileTree(head.id), {
			metric, iterations: { base: base.iterations, head: head.iterations },
		}).slice(0, limit);
	}

	async legacyIds() {
		return this.store.legacyIds();
	}

	async query(source: string, variables?: Record<string, unknown>) {
		return graphql({ schema: createSchema(), source, variableValues: variables, contextValue: createContext(this.store, this.principal, this.links) });
	}

	private requireRepository(slug: string | null): Repository {
		const repository = slug === null ? undefined : this.store.repositoryBySlug(slug);
		if (!repository) throw new Error(`No benchmarks or pull requests recorded for ${slug ?? "this repository"}.`);
		return repository;
	}

	private requireProfile(id: number): Profile {
		const profile = this.store.profile(id);
		if (!profile) throw new Error(`Unknown profile ${id}.`);
		return profile;
	}

	private detail(profile: Profile): ProfileDetail {
		return { profile, measurement: this.store.measurement(profile.measurementId)! };
	}
}

/** Validates a pull request reference before anything is saved. */
export const checkPullRequestReference = (reference: string | number) => parsePullRequestReference(String(reference));
