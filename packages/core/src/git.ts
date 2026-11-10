import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export interface CommitInfo {
	sha: string;
	subject: string | null;
	author: string | null;
	authoredAt: string | null;
	committedAt: string | null;
	parents: string[];
}

export interface RepositoryIdentity {
	/** Stable, machine-independent identity, e.g. `github.com/duckdb/duckdb`, or `local:<git dir>`. */
	slug: string;
	name: string;
	remoteUrl: string | null;
	/** GitHub `owner/name` of the preferred remote, if hosted on GitHub. */
	githubRepo: string | null;
	root: string | null;
}

export interface WorkingTree {
	root: string;
	head: string;
	branch: string | null;
	/** Uncommitted changes (including untracked files); computed on first use because status is slow in large trees. */
	dirty(): boolean;
}

export const FULL_SHA = /^[0-9a-f]{40}$/;

export function git(cwd: string, args: string[], options: { timeout?: number } = {}): string {
	return execFileSync("git", ["-C", cwd, ...args], {
		encoding: "utf8",
		timeout: options.timeout ?? 10_000,
		maxBuffer: 32 * 1024 * 1024,
		stdio: ["ignore", "pipe", "pipe"],
		env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
	}).trimEnd();
}

function tryGit(cwd: string, args: string[]): string | undefined {
	try {
		return git(cwd, args);
	} catch {
		return undefined;
	}
}

/** Normalizes SSH/HTTPS remotes to `host/owner/name`. */
export function normalizeRemote(url: string): string | null {
	const trimmed = url.trim().replace(/\/+$/, "").replace(/\.git$/, "");
	const scp = /^(?:[^@/]+@)?([^:/]+):(?!\/)(.+)$/.exec(trimmed);
	if (scp) return `${scp[1].toLowerCase()}/${scp[2]}`;
	try {
		const parsed = new URL(trimmed);
		if (!parsed.hostname) return null;
		return `${parsed.hostname.toLowerCase()}${parsed.pathname}`.replace(/\/+$/, "");
	} catch {
		return null;
	}
}

export function githubRepoOf(normalized: string | null): string | null {
	const match = normalized && /^github\.com\/([^/]+\/[^/]+)$/.exec(normalized);
	return match ? match[1] : null;
}

/**
 * Identifies the project behind a checkout. `upstream` wins over `origin` so forks and
 * worktrees of the same project share history; commits are content-addressed anyway.
 */
export function repositoryIdentity(cwd: string): RepositoryIdentity {
	const directory = fs.realpathSync(cwd);
	const root = tryGit(directory, ["rev-parse", "--show-toplevel"]);
	if (!root) {
		return { slug: `local:${directory}`, name: path.basename(directory), remoteUrl: null, githubRepo: null, root: null };
	}
	const remotes = (tryGit(root, ["remote"]) ?? "").split("\n").filter(Boolean);
	const preferred = ["upstream", "origin"].find((name) => remotes.includes(name)) ?? remotes[0];
	const remoteUrl = preferred ? tryGit(root, ["remote", "get-url", preferred]) ?? null : null;
	const normalized = remoteUrl ? normalizeRemote(remoteUrl) : null;
	if (normalized) {
		return { slug: normalized, name: normalized.split("/").pop()!, remoteUrl, githubRepo: githubRepoOf(normalized), root };
	}
	const common = tryGit(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]) ?? path.join(root, ".git");
	const main = path.basename(common) === ".git" ? path.dirname(common) : common;
	return { slug: `local:${fs.realpathSync(common)}`, name: path.basename(main), remoteUrl: null, githubRepo: null, root };
}

/** All GitHub repositories reachable through this checkout's remotes, preferred first. */
export function githubRemotes(cwd: string): string[] {
	const remotes = (tryGit(cwd, ["remote"]) ?? "").split("\n").filter(Boolean);
	const ordered = [...["upstream", "origin"].filter((name) => remotes.includes(name)), ...remotes.filter((name) => name !== "upstream" && name !== "origin")];
	const repos = ordered.map((name) => githubRepoOf(normalizeRemote(tryGit(cwd, ["remote", "get-url", name]) ?? "")));
	return [...new Set(repos.filter((repo): repo is string => repo !== null))];
}

export function workingTree(cwd: string): WorkingTree | null {
	const root = tryGit(cwd, ["rev-parse", "--show-toplevel"]);
	const head = root && tryGit(root, ["rev-parse", "HEAD"]);
	if (!root || !head) return null;
	const branch = tryGit(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]) ?? null;
	let dirty: boolean | undefined;
	return {
		root, head, branch,
		dirty: () => dirty ??= (tryGit(root, ["status", "--porcelain", "--untracked-files=normal"]) ?? "x").length > 0,
	};
}

const FORMAT = ["%H", "%P", "%an", "%aI", "%cI", "%s"].join("%x1f") + "%x1e";

function parseLog(output: string): CommitInfo[] {
	return output.split("\x1e").map((record) => record.replace(/^\n/, "")).filter(Boolean).map((record) => {
		const [sha, parents, author, authoredAt, committedAt, subject] = record.split("\x1f");
		return { sha, parents: parents ? parents.split(" ") : [], author, authoredAt, committedAt, subject };
	});
}

/** Resolves any revision (short SHA, branch, `HEAD~2`) to commit metadata, or null if unknown locally. */
const resolved = new Map<string, CommitInfo | null>();

export function resolveCommit(cwd: string, revision: string): CommitInfo | null {
	if (revision.startsWith("-")) return null;
	// Object names are immutable, so hex lookups are memoized; refs such as HEAD are always re-read.
	const key = /^[0-9a-f]{7,40}$/.test(revision) ? `${cwd}\0${revision}` : undefined;
	if (key && resolved.has(key)) return resolved.get(key)!;
	const output = tryGit(cwd, ["log", "-1", "--no-walk", `--format=${FORMAT}`, `${revision}^{commit}`, "--"]);
	const commit = output ? parseLog(output)[0] ?? null : null;
	if (key) resolved.set(key, commit);
	return commit;
}

/** Commits reachable from head but not base, oldest first. */
export function commitRange(cwd: string, base: string, head: string): CommitInfo[] {
	return parseLog(git(cwd, ["log", "--reverse", "--topo-order", `--format=${FORMAT}`, `${base}..${head}`, "--"]));
}

export function mergeBase(cwd: string, a: string, b: string): string {
	return git(cwd, ["merge-base", a, b]);
}
