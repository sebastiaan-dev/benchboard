import type { ExecutionResult } from "graphql";
import type { Backend, Identity, MethodName } from "./backend.ts";
import { encodeArgs } from "./wire.ts";

export class HttpError extends Error {
	readonly status: number;
	/** Worth retrying later: the server was unreachable, overloaded or restarting. */
	readonly transient: boolean;
	constructor(status: number, message: string, transient = false) {
		super(message);
		this.status = status;
		this.transient = transient;
	}
}

/** Statuses that say "try again" (timeouts, rate limits, proxies in front of a restarting server). */
const RETRYABLE = new Set([408, 425, 429, 502, 503, 504]);

export interface RetryPolicy {
	/** Attempts after the first. */
	retries: number;
	/** First delay; doubles each attempt, with jitter. */
	baseDelayMs: number;
}

export const defaultRetryPolicy = (): RetryPolicy => ({
	retries: Number.isSafeInteger(Number(process.env.BENCHBOARD_RETRIES)) ? Number(process.env.BENCHBOARD_RETRIES) : 5,
	baseDelayMs: 1000,
});

/**
 * A Benchboard server reached over HTTP(S), authenticated with an API token. Every method is safe to
 * retry: reads trivially, uploads because they carry idempotency keys and PR snapshots are upserts.
 */
export class RemoteBackend implements Backend {
	readonly webUrl: string;
	private readonly token: string | null;
	private readonly retry: RetryPolicy;
	/** Called before each retry, e.g. to tell the user. */
	onRetry: (attempt: number, delayMs: number, error: Error) => void = () => {};

	constructor(url: string, token: string | null, retry: RetryPolicy = defaultRetryPolicy()) {
		this.webUrl = normalizeServerUrl(url);
		this.token = token;
		this.retry = retry;
	}

	private headers(contentType: string | null): Record<string, string> {
		return {
			...(contentType ? { "content-type": contentType } : {}),
			...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
			"user-agent": "benchboard-cli",
		};
	}

	private async withRetries<T>(attempt: () => Promise<T>): Promise<T> {
		for (let tries = 0; ; tries++) {
			try {
				return await attempt();
			} catch (error) {
				if (!(error instanceof HttpError) || !error.transient || tries >= this.retry.retries) throw error;
				const delay = this.retry.baseDelayMs * 2 ** tries * (0.75 + Math.random() * 0.5);
				this.onRetry(tries + 1, delay, error);
				await Bun.sleep(delay);
			}
		}
	}

	private async send(path: string, init: RequestInit): Promise<Response> {
		try {
			return await fetch(`${this.webUrl}${path}`, init);
		} catch (error) {
			throw new HttpError(0, `Cannot reach ${this.webUrl}: ${(error as Error).message}`, true);
		}
	}

	private call<T>(method: MethodName, ...args: unknown[]): Promise<T> {
		const { body, contentType } = encodeArgs(args);
		return this.withRetries(async () => {
			const response = await this.send(`/api/v1/rpc/${method}`, { method: "POST", headers: this.headers(contentType), body });
			const payload = (await response.json().catch(() => null)) as { result?: T; error?: { message: string } } | null;
			if (!response.ok || !payload || !("result" in payload)) {
				const message = payload?.error?.message ?? `HTTP ${response.status} ${response.statusText}`;
				const hint = response.status === 401 ? " Sign in with `benchboard login <url>` or set BENCHBOARD_TOKEN." : "";
				throw new HttpError(response.status, `${this.webUrl}: ${message}${hint}`, RETRYABLE.has(response.status) || (!payload && response.status >= 500));
			}
			return payload.result as T;
		});
	}

	invoke(method: MethodName, args: unknown[]): Promise<unknown> {
		return this.call(method, ...args);
	}

	whoami = () => this.call<Identity>("whoami");
	ingest: Backend["ingest"] = (run, options) => this.call("ingest", run, options);
	savePullRequest: Backend["savePullRequest"] = (snapshot) => this.call("savePullRequest", snapshot);
	resolvePullRequest: Backend["resolvePullRequest"] = (slug, reference) => this.call("resolvePullRequest", slug, reference);
	pullRequests: Backend["pullRequests"] = (slug) => this.call("pullRequests", slug);
	pullRequestReport: Backend["pullRequestReport"] = (id, options) => this.call("pullRequestReport", id, options);
	repository: Backend["repository"] = (id) => this.call("repository", id);
	repositoryBySlug: Backend["repositoryBySlug"] = (slug) => this.call("repositoryBySlug", slug);
	runs: Backend["runs"] = (slug, limit) => this.call("runs", slug, limit);
	measurement: Backend["measurement"] = (reference) => this.call("measurement", reference);
	attachProfile: Backend["attachProfile"] = (measurementId, profile) => this.call("attachProfile", measurementId, profile);
	profile: Backend["profile"] = (id) => this.call("profile", id);
	profileFunctions: Backend["profileFunctions"] = (id, metric, limit) => this.call("profileFunctions", id, metric, limit);
	profileDiff: Backend["profileDiff"] = (base, head, metric, limit) => this.call("profileDiff", base, head, metric, limit);
	legacyIds: Backend["legacyIds"] = () => this.call("legacyIds");
	syncGithubPullRequest: Backend["syncGithubPullRequest"] = (repository, reference, candidates) =>
		this.call("syncGithubPullRequest", repository, reference, candidates);
	runDetail: Backend["runDetail"] = (slug, reference, options) => this.call("runDetail", slug, reference, options);

	query(source: string, variables?: Record<string, unknown>): Promise<ExecutionResult> {
		return this.withRetries(async () => {
			const response = await this.send("/graphql", {
				method: "POST",
				headers: { ...this.headers("application/json"), accept: "application/graphql-response+json, application/json" },
				body: JSON.stringify({ query: source, variables }),
			});
			const body = await response.json().catch(() => null);
			if (!body) throw new HttpError(response.status, `${this.webUrl}/graphql: HTTP ${response.status}`, RETRYABLE.has(response.status));
			return body as ExecutionResult;
		});
	}
}

export function normalizeServerUrl(url: string): string {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new Error(`Invalid server URL: ${url}`);
	}
	if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("The server URL must be http(s).");
	if (parsed.pathname.replace(/\/+$/, "") !== "") throw new Error("Benchboard is served at the root of its host; pass only the origin, e.g. https://bench.example.com.");
	return parsed.origin;
}
