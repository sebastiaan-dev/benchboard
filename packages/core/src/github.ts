import { execFileSync } from "node:child_process";
import type { CommitInfo, RepositoryIdentity } from "./git.ts";
import type { PullRequestSnapshot } from "./prepare.ts";

/**
 * GitHub REST access with plain fetch, so it works where the `gh` CLI is not installed (a server
 * container). Credentials: GITHUB_TOKEN or GH_TOKEN, else `gh auth token` when gh is available, else
 * anonymous (public repositories, low rate limit). GITHUB_API_URL selects GitHub Enterprise.
 */
export interface GithubPullRequest {
	githubRepo: string;
	number: number;
	title: string;
	url: string;
	state: "open" | "closed" | "merged";
	author: string | null;
	headRef: string;
	headSha: string;
	baseRef: string;
	baseSha: string | null;
	updatedAt: string | null;
	commits: CommitInfo[];
}

let cachedToken: string | null | undefined;

function githubToken(): string | null {
	const fromEnv = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
	if (fromEnv) return fromEnv;
	if (cachedToken === undefined) {
		try {
			cachedToken = execFileSync("gh", ["auth", "token"], { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
		} catch {
			cachedToken = null;
		}
	}
	return cachedToken;
}

const apiBase = () => (process.env.GITHUB_API_URL || "https://api.github.com").replace(/\/+$/, "");

async function api(route: string): Promise<{ body: unknown; next: string | null }> {
	const token = githubToken();
	const url = route.startsWith("http") ? route : `${apiBase()}/${route}`;
	let response: Response;
	try {
		response = await fetch(url, {
			headers: {
				accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "benchboard",
				...(token ? { authorization: `Bearer ${token}` } : {}),
			},
			signal: AbortSignal.timeout(60_000),
		});
	} catch (error) {
		throw new Error(`GitHub request failed: ${(error as Error).message}`);
	}
	if (!response.ok) {
		const message = ((await response.json().catch(() => null)) as { message?: string } | null)?.message ?? response.statusText;
		const hint = response.status === 401 || response.status === 403 || response.status === 404
			? token ? "" : " (no GitHub credentials: set GITHUB_TOKEN or run `gh auth login`)" : "";
		throw new Error(`GitHub ${route.replace(apiBase(), "")}: HTTP ${response.status} ${message}${hint}`);
	}
	const next = /<([^>]+)>;\s*rel="next"/.exec(response.headers.get("link") ?? "")?.[1] ?? null;
	return { body: await response.json(), next };
}

/** Accepts `123`, `#123`, `owner/name#123` or a GitHub pull request URL. */
export function parsePullRequestReference(reference: string): { githubRepo?: string; number: number } {
	const url = /^https?:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(reference);
	if (url) return { githubRepo: url[1], number: Number(url[2]) };
	const qualified = /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(reference);
	if (qualified) return { githubRepo: qualified[1], number: Number(qualified[2]) };
	const bare = /^#?(\d+)$/.exec(reference);
	if (bare) return { number: Number(bare[1]) };
	throw new Error(`Unrecognized pull request reference: ${reference}`);
}

interface ApiCommit {
	sha: string;
	parents: { sha: string }[];
	author: { login: string } | null;
	commit: { message: string; author: { name: string; date: string } | null; committer: { date: string } | null };
}

const toCommit = (entry: ApiCommit): CommitInfo => ({
	sha: entry.sha,
	parents: entry.parents.map((parent) => parent.sha),
	author: entry.commit.author?.name ?? entry.author?.login ?? null,
	authoredAt: entry.commit.author?.date ?? null,
	committedAt: entry.commit.committer?.date ?? null,
	subject: entry.commit.message.split("\n", 1)[0],
});

export async function fetchPullRequest(githubRepo: string, number: number): Promise<GithubPullRequest> {
	if (!/^[\w.-]+\/[\w.-]+$/.test(githubRepo) || !Number.isSafeInteger(number) || number <= 0) {
		throw new Error("Invalid GitHub repository or pull request number.");
	}
	const pr = (await api(`repos/${githubRepo}/pulls/${number}`)).body as {
		number: number; title: string; html_url: string; state: string; merged_at: string | null; updated_at: string;
		user: { login: string } | null; head: { ref: string; sha: string }; base: { ref: string; sha: string };
	};
	// GitHub returns at most 250 commits here, oldest first.
	const commits: CommitInfo[] = [];
	for (let page: string | null = `repos/${githubRepo}/pulls/${number}/commits?per_page=100`; page;) {
		const { body, next } = await api(page);
		commits.push(...(body as ApiCommit[]).map(toCommit));
		page = next;
	}
	return {
		githubRepo,
		number: pr.number,
		title: pr.title,
		url: pr.html_url,
		state: pr.merged_at ? "merged" : pr.state === "open" ? "open" : "closed",
		author: pr.user?.login ?? null,
		headRef: pr.head.ref,
		headSha: pr.head.sha,
		baseRef: pr.base.ref,
		// The commit the PR's first commit was built on; base.sha is the moving tip of the base branch.
		baseSha: commits[0]?.parents[0] ?? null,
		updatedAt: pr.updated_at,
		commits,
	};
}

export async function fetchCommit(githubRepo: string, sha: string): Promise<CommitInfo | null> {
	try {
		return toCommit((await api(`repos/${githubRepo}/commits/${sha}`)).body as ApiCommit);
	} catch {
		return null;
	}
}

/**
 * Fetches a pull request from the first candidate repository that has it.
 * `resolveLocal` looks commits up in a checkout first (cheaper, and works offline for the base).
 */
export async function snapshotGithubPullRequest(options: {
	number: number;
	candidates: string[];
	repository: RepositoryIdentity | null;
	resolveLocal?: (sha: string) => CommitInfo | null;
}): Promise<PullRequestSnapshot> {
	if (!options.candidates.length) throw new Error("Cannot infer the GitHub repository; pass owner/name#number or a pull request URL.");
	const errors: string[] = [];
	for (const githubRepo of options.candidates) {
		let pr: GithubPullRequest;
		try {
			pr = await fetchPullRequest(githubRepo, options.number);
		} catch (error) {
			errors.push((error as Error).message);
			continue;
		}
		const base = pr.baseSha ? options.resolveLocal?.(pr.baseSha) ?? await fetchCommit(pr.githubRepo, pr.baseSha) : null;
		const { commits, ...fields } = pr;
		return { repository: options.repository, pullRequest: { source: "github", ...fields }, base, commits };
	}
	throw new Error(errors.join("\n"));
}
