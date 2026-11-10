import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CommitInfo } from "./git.ts";

const run = promisify(execFile);

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

async function gh(args: string[]): Promise<unknown> {
	try {
		const { stdout } = await run("gh", args, { maxBuffer: 64 * 1024 * 1024, timeout: 60_000 });
		return JSON.parse(stdout);
	} catch (error) {
		const stderr = (error as { stderr?: string }).stderr?.trim();
		throw new Error(`gh ${args.slice(0, 2).join(" ")} failed: ${stderr || (error as Error).message}`);
	}
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

export async function fetchPullRequest(githubRepo: string, number: number): Promise<GithubPullRequest> {
	if (!/^[\w.-]+\/[\w.-]+$/.test(githubRepo) || !Number.isSafeInteger(number) || number <= 0) {
		throw new Error("Invalid GitHub repository or pull request number.");
	}
	const pr = await gh(["api", `repos/${githubRepo}/pulls/${number}`]) as {
		number: number; title: string; html_url: string; state: string; merged_at: string | null; updated_at: string;
		user: { login: string } | null; head: { ref: string; sha: string }; base: { ref: string; sha: string };
	};
	// GitHub returns at most 250 commits here, oldest first.
	const pages = await gh(["api", "--paginate", "--slurp", `repos/${githubRepo}/pulls/${number}/commits?per_page=100`]) as ApiCommit[][];
	const commits = pages.flat().map((entry): CommitInfo => ({
		sha: entry.sha,
		parents: entry.parents.map((parent) => parent.sha),
		author: entry.commit.author?.name ?? entry.author?.login ?? null,
		authoredAt: entry.commit.author?.date ?? null,
		committedAt: entry.commit.committer?.date ?? null,
		subject: entry.commit.message.split("\n", 1)[0],
	}));
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
		const entry = await gh(["api", `repos/${githubRepo}/commits/${sha}`]) as ApiCommit;
		return {
			sha: entry.sha, parents: entry.parents.map((parent) => parent.sha),
			author: entry.commit.author?.name ?? entry.author?.login ?? null,
			authoredAt: entry.commit.author?.date ?? null, committedAt: entry.commit.committer?.date ?? null,
			subject: entry.commit.message.split("\n", 1)[0],
		};
	} catch {
		return null;
	}
}
