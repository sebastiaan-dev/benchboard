import type { ExecutionResult } from "graphql";
import type { Backend, Identity, MethodName } from "./backend.ts";
import { encodeArgs } from "./wire.ts";

export class HttpError extends Error {
	readonly status: number;
	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

/** A Benchboard server reached over HTTP(S), authenticated with an API token. */
export class RemoteBackend implements Backend {
	readonly webUrl: string;
	private readonly token: string | null;

	constructor(url: string, token: string | null) {
		this.webUrl = normalizeServerUrl(url);
		this.token = token;
	}

	private headers(contentType: string | null): Record<string, string> {
		return {
			...(contentType ? { "content-type": contentType } : {}),
			...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
			"user-agent": "benchboard-cli",
		};
	}

	private async call<T>(method: MethodName, ...args: unknown[]): Promise<T> {
		const { body, contentType } = encodeArgs(args);
		let response: Response;
		try {
			response = await fetch(`${this.webUrl}/api/v1/rpc/${method}`, { method: "POST", headers: this.headers(contentType), body });
		} catch (error) {
			throw new Error(`Cannot reach ${this.webUrl}: ${(error as Error).message}`);
		}
		const payload = (await response.json().catch(() => null)) as { result?: T; error?: { message: string } } | null;
		if (!response.ok || !payload || !("result" in payload)) {
			const message = payload?.error?.message ?? `HTTP ${response.status} ${response.statusText}`;
			const hint = response.status === 401 ? " Sign in with `benchboard login <url>` or set BENCHBOARD_TOKEN." : "";
			throw new HttpError(response.status, `${this.webUrl}: ${message}${hint}`);
		}
		return payload.result as T;
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

	async query(source: string, variables?: Record<string, unknown>): Promise<ExecutionResult> {
		const response = await fetch(`${this.webUrl}/graphql`, {
			method: "POST",
			headers: { ...this.headers("application/json"), accept: "application/graphql-response+json, application/json" },
			body: JSON.stringify({ query: source, variables }),
		});
		const body = await response.json().catch(() => null);
		if (!body) throw new HttpError(response.status, `${this.webUrl}/graphql: HTTP ${response.status}`);
		return body as ExecutionResult;
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
