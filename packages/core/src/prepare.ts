/**
 * Client-side preparation. Everything that reads the measuring machine's files or git checkout happens
 * here and produces plain, serializable values; the store only ever receives these, so the same code
 * path serves a local data directory and a remote server (where client paths mean nothing).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { z } from "zod";
import { parseHyperfineExport, MAX_EXPORT_BYTES } from "./hyperfine.ts";
import { MachineMetadata, parseMetadata, type IngestMetadata, type ProfileMetadata } from "./metadata.ts";
import {
	FULL_SHA, commitRange, mergeBase, repositoryIdentity, resolveCommit, workingTree, type CommitInfo, type RepositoryIdentity,
} from "./git.ts";
import { MAX_PROFILE_BYTES } from "./profile.ts";

export interface CheckoutState {
	path: string | null;
	head: string | null;
	branch: string | null;
	dirty: boolean | null;
}

/** A profile's raw bytes and how it was recorded. */
export interface PreparedProfile {
	bytes: Uint8Array;
	syms: Uint8Array | null;
	/** Display name of the symbol sidecar, for error messages. */
	symsName: string | null;
	iterations?: number;
	label?: string;
	command?: string;
}

/** A Hyperfine export with every case attributed to a commit, ready to store anywhere. */
export interface PreparedRun {
	export: Uint8Array;
	sourcePath: string | null;
	/** Ingest metadata; per-case `profile` paths are replaced by `profiles`. */
	metadata: unknown;
	repository: RepositoryIdentity;
	checkout: CheckoutState | null;
	cases: { sha: string | null; dirty: boolean | null; inferred: boolean }[];
	/** Metadata of the commits the cases refer to, where the checkout knows them. */
	commits: CommitInfo[];
	machine: MachineMetadata;
	recordedAt?: string;
	legacyId?: string;
	profiles: (PreparedProfile & { caseIndex: number })[];
	warnings: string[];
}

/** A pull request (GitHub) or branch (local) with its commits, ready to store. */
export interface PullRequestSnapshot {
	/** The checkout's repository identity; null when only the GitHub repository is known. */
	repository: RepositoryIdentity | null;
	pullRequest: {
		source: "github" | "local";
		githubRepo: string | null;
		number: number | null;
		title: string;
		url: string | null;
		state: string;
		author: string | null;
		headRef: string;
		headSha: string;
		baseRef: string;
		baseSha: string | null;
		updatedAt: string | null;
	};
	base: CommitInfo | null;
	commits: CommitInfo[];
}

export interface IngestInput {
	/** Hyperfine export path, resolved against cwd. */
	file: string;
	/** Checkout used to resolve repository identity and revisions. */
	cwd: string;
	metadata?: unknown;
	/** Overrides for importers; not part of the public metadata contract. */
	internal?: {
		recordedAt?: string;
		legacyId?: string;
		inferredCommits?: { sha: string | null; dirty: boolean | null }[];
		repository?: RepositoryIdentity;
		/** Checkout state at measurement time, when it differs from the importing checkout. */
		checkout?: CheckoutState;
	};
}

export interface ProfileInput {
	file: string;
	syms?: string | null;
	iterations?: number;
	label?: string;
	command?: string;
	cwd?: string;
}

export function sidecarPath(file: string): string {
	return file.replace(/\.gz$/, "").replace(/(\.json)?$/, ".json.syms.json");
}

const expand = (cwd: string, file: string) => path.resolve(cwd, file.startsWith("~/") ? path.join(os.homedir(), file.slice(2)) : file);

export function readBounded(file: string, limit = MAX_EXPORT_BYTES): Buffer {
	const fd = fs.openSync(file, "r");
	try {
		const stat = fs.fstatSync(fd);
		if (!stat.isFile() || stat.size > limit) throw new Error(`Expected a regular file of at most ${limit / 1024 / 1024} MiB: ${file}`);
		const bytes = Buffer.alloc(stat.size);
		let length = 0;
		while (length < stat.size) {
			const read = fs.readSync(fd, bytes, length, stat.size - length, null);
			if (read === 0) break;
			length += read;
		}
		if (length !== stat.size) throw new Error("Export changed while being read; retry after Hyperfine finishes.");
		return bytes;
	} finally {
		fs.closeSync(fd);
	}
}

export function localMachine(): MachineMetadata {
	return {
		hostname: os.hostname(), os: `${os.platform()} ${os.release()}`, arch: os.arch(),
		cpu: os.cpus()[0]?.model ?? "Unknown", ram: os.totalmem(),
	};
}

export function prepareProfile(input: ProfileInput): PreparedProfile {
	const cwd = input.cwd ?? process.cwd();
	const file = expand(cwd, input.file);
	const symsFile = input.syms === null ? null : input.syms ? expand(cwd, input.syms) : fs.existsSync(sidecarPath(file)) ? sidecarPath(file) : null;
	return {
		bytes: readBounded(file, MAX_PROFILE_BYTES),
		syms: symsFile ? readBounded(symsFile, MAX_PROFILE_BYTES) : null,
		symsName: symsFile ? path.basename(symsFile) : null,
		iterations: input.iterations, label: input.label, command: input.command,
	};
}

/** Reads the export and its profiles and attributes every case to a commit of the checkout at `cwd`. */
export function prepareRun(input: IngestInput): PreparedRun {
	const source = expand(input.cwd, input.file);
	const bytes = readBounded(source);
	const cases = parseHyperfineExport(bytes);
	const meta: IngestMetadata = parseMetadata(input.metadata);
	if (meta.cases && meta.cases.length !== cases.length) {
		throw new Error(`Metadata describes ${meta.cases.length} cases but the export has ${cases.length}; keep them in export order.`);
	}
	const warnings: string[] = [];
	const identity = input.internal?.repository ?? repositoryIdentity(input.cwd);
	const root = identity.root;
	// Importers that supply the historical checkout state skip the (slow, in large trees) live inspection.
	const tree = root && input.internal?.checkout === undefined ? workingTree(input.cwd) : null;
	const checkout = input.internal?.checkout !== undefined ? input.internal.checkout
		: tree && { path: tree.root, head: tree.head, branch: tree.branch, dirty: tree.dirty() };
	const commits = new Map<string, CommitInfo>();
	const known = (info: CommitInfo | null) => {
		if (info) commits.set(info.sha, info);
		return info;
	};
	const resolved = cases.map((_, index) => {
		const inferred = input.internal?.inferredCommits?.[index];
		if (inferred) {
			const info = known(inferred.sha && root ? resolveCommit(root, inferred.sha) : null);
			return { sha: info?.sha ?? inferred.sha, dirty: inferred.dirty, inferred: true };
		}
		const caseMeta = meta.cases?.[index];
		const revision = caseMeta?.commit ?? meta.commit;
		if (revision) {
			const info = known(root ? resolveCommit(root, revision) : null);
			if (!info && !FULL_SHA.test(revision)) {
				throw new Error(`Cannot resolve revision "${revision}" in ${input.cwd}; fetch it or pass a full 40-character SHA.`);
			}
			return { sha: info?.sha ?? revision, dirty: caseMeta?.dirty ?? meta.dirty ?? false, inferred: false };
		}
		known(tree ? resolveCommit(tree.root, tree.head) : null);
		return { sha: tree?.head ?? null, dirty: caseMeta?.dirty ?? meta.dirty ?? tree?.dirty() ?? null, inferred: true };
	});
	if (!meta.commit && !meta.cases?.some((entry) => entry.commit) && !input.internal?.inferredCommits) {
		warnings.push(tree
			? `No commit recorded; attributed all cases to checkout HEAD ${tree.head.slice(0, 12)}${tree.dirty() ? " (dirty)" : ""}.`
			: "No commit recorded and the working directory is not a git checkout; measurements are not attributable to commits.");
	}
	const profiles: PreparedRun["profiles"] = [];
	meta.cases?.forEach((entry, caseIndex) => {
		const list = entry.profile === undefined ? [] : Array.isArray(entry.profile) ? entry.profile : [entry.profile];
		for (const profile of list) {
			const spec: Exclude<ProfileMetadata, string> = typeof profile === "string" ? { file: profile } : profile;
			profiles.push({ ...prepareProfile({ ...spec, cwd: input.cwd }), caseIndex });
		}
	});
	const metadata = {
		...meta, machine: undefined,
		cases: meta.cases?.map((entry) => {
			const copy = { ...entry };
			delete copy.profile;
			return copy;
		}),
	};
	return {
		export: bytes, sourcePath: source, metadata, repository: identity, checkout, cases: resolved,
		commits: [...commits.values()], machine: meta.machine ?? localMachine(),
		recordedAt: input.internal?.recordedAt, legacyId: input.internal?.legacyId, profiles, warnings,
	};
}

/** Snapshots a local branch like a pull request: commits in `base..head`, oldest first. */
export function snapshotLocalBranch(options: { cwd: string; head?: string; base?: string; title?: string }): PullRequestSnapshot {
	const tree = workingTree(options.cwd);
	if (!tree) throw new Error(`${options.cwd} is not a git checkout.`);
	const headRef = options.head ?? tree.branch;
	if (!headRef) throw new Error("HEAD is detached; pass the branch to track.");
	const head = resolveCommit(tree.root, headRef);
	if (!head) throw new Error(`Cannot resolve ${headRef}.`);
	const candidates = options.base ? [options.base] : ["upstream/HEAD", "origin/HEAD", "upstream/main", "origin/main", "main", "master"];
	let best: { ref: string; base: string; commits: CommitInfo[] } | undefined;
	for (const ref of candidates) {
		if (!resolveCommit(tree.root, ref)) continue;
		const base = mergeBase(tree.root, ref, head.sha);
		const commits = commitRange(tree.root, base, head.sha);
		// The closest base yields the fewest branch-only commits.
		if (!best || commits.length < best.commits.length) best = { ref, base, commits };
	}
	if (!best) throw new Error(options.base ? `Cannot resolve base ${options.base}.` : "Cannot find a base branch; pass one explicitly.");
	return {
		repository: repositoryIdentity(tree.root),
		pullRequest: {
			source: "local", githubRepo: null, number: null, title: options.title ?? headRef, url: null, state: "open",
			author: head.author, headRef, headSha: head.sha, baseRef: best.ref, baseSha: best.base, updatedAt: head.committedAt,
		},
		base: resolveCommit(tree.root, best.base),
		commits: best.commits,
	};
}

// ── Validation of prepared values received from untrusted clients ──────────────────────────────────

const sha = z.string().regex(FULL_SHA, "Expected a full 40-character commit SHA.");
const short = (max: number) => z.string().max(max);
const bytes = z.instanceof(Uint8Array);

const CommitInfoSchema = z.object({
	sha, subject: short(4096).nullable(), author: short(512).nullable(), authoredAt: short(64).nullable(),
	committedAt: short(64).nullable(), parents: z.array(sha).max(64),
}).strict();

const RepositoryIdentitySchema = z.object({
	slug: z.string().min(1).max(1024), name: z.string().min(1).max(256), remoteUrl: short(2048).nullable(),
	githubRepo: z.string().regex(/^[\w.-]+\/[\w.-]+$/).nullable(), root: short(4096).nullable(),
}).strict();

const PreparedProfileSchema = z.object({
	bytes, syms: bytes.nullable(), symsName: short(4096).nullable(),
	iterations: z.number().int().positive().optional(), label: short(200).optional(), command: short(16_384).optional(),
}).strict();

const PreparedRunSchema = z.object({
	export: bytes,
	sourcePath: short(4096).nullable(),
	metadata: z.unknown(),
	repository: RepositoryIdentitySchema,
	checkout: z.object({
		path: short(4096).nullable(), head: sha.nullable(), branch: short(1024).nullable(), dirty: z.boolean().nullable(),
	}).strict().nullable(),
	cases: z.array(z.object({ sha: sha.nullable(), dirty: z.boolean().nullable(), inferred: z.boolean() }).strict()).max(512),
	commits: z.array(CommitInfoSchema).max(1024),
	machine: MachineMetadata,
	recordedAt: z.iso.datetime({ offset: true }).optional(),
	legacyId: short(256).optional(),
	profiles: z.array(PreparedProfileSchema.extend({ caseIndex: z.number().int().nonnegative() })).max(1024),
	warnings: z.array(short(4096)).max(1024),
}).strict();

const PullRequestSnapshotSchema = z.object({
	repository: RepositoryIdentitySchema.nullable(),
	pullRequest: z.object({
		source: z.enum(["github", "local"]), githubRepo: z.string().regex(/^[\w.-]+\/[\w.-]+$/).nullable(),
		number: z.number().int().positive().nullable(), title: short(4096), url: short(2048).nullable(), state: short(32),
		author: short(512).nullable(), headRef: z.string().min(1).max(1024), headSha: sha, baseRef: z.string().min(1).max(1024),
		baseSha: sha.nullable(), updatedAt: short(64).nullable(),
	}).strict().refine((pr) => (pr.source === "github") === (pr.githubRepo !== null && pr.number !== null),
		"GitHub pull requests need a repository and number; local branches have neither."),
	base: CommitInfoSchema.nullable(),
	commits: z.array(CommitInfoSchema).max(10_000),
}).strict();

function validate<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
	const result = schema.safeParse(value);
	if (!result.success) {
		throw new Error(`Invalid ${what}:\n` + result.error.issues.map((issue) => `  ${issue.path.join(".") || "(root)"}: ${issue.message}`).join("\n"));
	}
	return result.data;
}

export const parsePreparedRun = (value: unknown) => validate(PreparedRunSchema, value, "prepared run") as PreparedRun;
export const parsePreparedProfile = (value: unknown) => validate(PreparedProfileSchema, value, "prepared profile") as PreparedProfile;
export const parsePullRequestSnapshot = (value: unknown) => validate(PullRequestSnapshotSchema, value, "pull request snapshot") as PullRequestSnapshot;
