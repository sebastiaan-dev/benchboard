import * as path from "node:path";
import { createHmac, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createYoga } from "graphql-yoga";
import { createContext, createSchema, type Context, type Links } from "@benchboard/graphql";
import { allows, authenticate, listTokens, serverSecret, SCHEMA_VERSION, type Principal, type Scope, type Store } from "@benchboard/core";
import { LocalBackend, METHODS, VERSION, type MethodName } from "./backend.ts";
import { decodeArgs } from "./wire.ts";
import { profileRoutes } from "./profile-routes.ts";

export const DEFAULT_PORT = 4319;
const COOKIE = "bb_session";
const SESSION_DAYS = 30;
const LINK_HOURS = 24;

const webRoot = fileURLToPath(new URL("../../../apps/web/dist/", import.meta.url));

export type AuthMode = "none" | "token";

export interface ServerOptions {
	host: string;
	port: number;
	/**
	 * "none": no credentials (local use; the default on loopback addresses). "token": API tokens, as
	 * bearer headers (CLI) or a session cookie (browser); the default everywhere else.
	 */
	auth?: AuthMode;
	/** Externally visible origin, e.g. https://bench.example.com; used for links, allowed Host/Origin and Secure cookies. */
	publicUrl?: string;
	/** Let unauthenticated visitors read (token mode only). */
	publicRead?: boolean;
	/** Extra browser origins allowed to call the API (e.g. a Vite dev server). */
	allowedOrigins?: string[];
	/** Write one line per request to stderr. */
	accessLog?: boolean;
	maxRequestBodyBytes?: number;
}

export const isLoopback = (host: string) => ["127.0.0.1", "::1", "localhost"].includes(host) || host.startsWith("127.");

/** Server options from flags, falling back to BENCHBOARD_* environment variables. */
export function serverOptionsFromEnv(flags: { host?: string; port?: string; auth?: string; publicUrl?: string }): ServerOptions {
	const env = process.env;
	const host = flags.host ?? env.BENCHBOARD_HOST ?? "127.0.0.1";
	const port = Number(flags.port ?? env.BENCHBOARD_PORT ?? DEFAULT_PORT);
	if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error("The port must be an integer between 0 and 65535.");
	const auth = flags.auth ?? env.BENCHBOARD_AUTH ?? (isLoopback(host) ? "none" : "token");
	if (auth !== "none" && auth !== "token") throw new Error("--auth must be none or token.");
	const publicUrl = flags.publicUrl ?? env.BENCHBOARD_PUBLIC_URL;
	if (publicUrl) {
		const parsed = new URL(publicUrl);
		if (parsed.pathname.replace(/\/+$/, "") !== "") throw new Error("BENCHBOARD_PUBLIC_URL must be an origin (Benchboard is served at the root).");
	}
	const flag = (value: string | undefined) => value === "1" || value === "true";
	return {
		host, port, auth, publicUrl: publicUrl ? new URL(publicUrl).origin : undefined,
		publicRead: flag(env.BENCHBOARD_PUBLIC_READ),
		allowedOrigins: (env.BENCHBOARD_ALLOWED_ORIGINS ?? "").split(",").map((entry) => entry.trim().replace(/\/+$/, "")).filter(Boolean),
		accessLog: env.BENCHBOARD_ACCESS_LOG === undefined ? !isLoopback(host) : flag(env.BENCHBOARD_ACCESS_LOG),
		maxRequestBodyBytes: Number(env.BENCHBOARD_MAX_UPLOAD_MB ?? 1024) * 1024 * 1024,
	};
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
	Response.json(body, { status, headers: { "cache-control": "no-store", ...headers } });
const failure = (status: number, message: string) => json(status, { error: { message }, errors: [{ message }] });

/** Web app files embedded in a standalone binary (URL path → embedded file), replacing apps/web/dist. */
let embeddedWebApp: Map<string, string> | null = null;
export function useEmbeddedWebApp(files: Record<string, string>) {
	embeddedWebApp = new Map(Object.entries(files));
}

async function serveStatic(url: URL): Promise<Response> {
	let asset: ReturnType<typeof Bun.file>;
	if (embeddedWebApp) {
		const embedded = embeddedWebApp.get(decodeURIComponent(url.pathname));
		// Client-side routes fall back to the SPA shell.
		asset = Bun.file(embedded ?? embeddedWebApp.get("/index.html") ?? "/nonexistent");
	} else {
		const file = path.normalize(path.join(webRoot, decodeURIComponent(url.pathname)));
		if (!file.startsWith(webRoot)) return new Response(null, { status: 403 });
		asset = Bun.file(file);
		if (url.pathname.endsWith("/") || !(await asset.exists())) asset = Bun.file(path.join(webRoot, "index.html"));
	}
	if (!(await asset.exists())) {
		return new Response("The web app is not built. Run `bun run build` in the benchboard repository, or use `bun run dev`.\nGraphQL is available at /graphql.\n",
			{ status: 503, headers: { "content-type": "text/plain; charset=utf-8" } });
	}
	const immutable = url.pathname.startsWith("/assets/");
	return new Response(asset, { headers: { "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache" } });
}

function cookie(request: Request, name: string): string | null {
	for (const part of (request.headers.get("cookie") ?? "").split(";")) {
		const [key, ...value] = part.trim().split("=");
		if (key === name) return decodeURIComponent(value.join("="));
	}
	return null;
}

/** Who a request acts for. `ambient`: credentials the browser attaches by itself, which need CSRF protection. */
interface Caller {
	principal: Principal | null;
	ambient: boolean;
}

export type Route = (request: Request, url: URL, caller: Caller) => Response | undefined | Promise<Response | undefined>;

export function createServer(store: Store, options: ServerOptions) {
	const auth = options.auth ?? (isLoopback(options.host) ? "none" : "token");
	const secret = serverSecret(store.home);
	const sign = (value: string) => createHmac("sha256", secret).update(value).digest("base64url");
	// A synchronizer token for browser writes: readable only by same-origin pages (there is no CORS).
	const csrf = sign("csrf");
	const csrfBytes = Buffer.from(csrf);
	const hasCsrf = (request: Request) => {
		const supplied = Buffer.from(request.headers.get("x-benchboard-csrf") ?? "");
		return supplied.length === csrfBytes.length && timingSafeEqual(supplied, csrfBytes);
	};
	const publicOrigin = options.publicUrl ?? null;
	const loopbackOrigins = ["localhost", "127.0.0.1", "[::1]"].map((name) => `http://${name}:${options.port}`);
	const origins = new Set([
		...loopbackOrigins, `http://${options.host.includes(":") ? `[${options.host}]` : options.host}:${options.port}`,
		...(publicOrigin ? [publicOrigin] : []), ...(options.allowedOrigins ?? []),
	]);
	const allowedHosts = new Set(["localhost", "127.0.0.1", "::1", options.host.toLowerCase(), ...(publicOrigin ? [new URL(publicOrigin).hostname] : [])]);
	/**
	 * Without credentials, only known host names are served (blocks DNS rebinding against a local server).
	 * With token auth, credentials protect the data and the server may sit behind any name.
	 */
	const hostAllowed = (host: string | null) => {
		if (!host) return false;
		if (auth === "token" && !publicOrigin) return true;
		return allowedHosts.has(host.replace(/:\d+$/, "").replace(/^\[|\]$/g, "").toLowerCase());
	};
	/** Browser requests from other origins are refused outright: Origin covers cross-origin requests, Sec-Fetch-Site the rest. */
	const foreign = (request: Request) => {
		const origin = request.headers.get("origin");
		if (origin !== null && !origins.has(origin)) return true;
		const site = request.headers.get("sec-fetch-site");
		return site === "cross-site" || (site === "same-site" && origin === null);
	};
	const secureCookies = publicOrigin?.startsWith("https:") ?? false;
	const sessionCookie = (value: string, maxAge: number) =>
		`${COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secureCookies ? "; Secure" : ""}`;

	const caller = (request: Request): Caller | Response => {
		if (auth === "none") return { principal: { name: "local", scope: "admin", tokenId: null }, ambient: true };
		const header = request.headers.get("authorization");
		if (header !== null) {
			const principal = /^Bearer\s+(\S+)$/i.exec(header) && authenticate(store, header.replace(/^Bearer\s+/i, ""));
			if (!principal) return failure(401, "Invalid or revoked API token.");
			return { principal, ambient: false };
		}
		const session = cookie(request, COOKIE);
		const principal = session ? authenticate(store, session) : null;
		if (principal) return { principal, ambient: true };
		return { principal: options.publicRead ? { name: "anonymous", scope: "read", tokenId: null } : null, ambient: false };
	};
	/**
	 * The scope a request may use. Browser requests (they always carry Origin or Sec-Fetch-Site) with
	 * ambient credentials (a cookie, or none at all in "none" mode) write only with the CSRF token.
	 */
	const effective = (request: Request, who: Caller): Principal | null => {
		if (!who.principal) return null;
		const browser = request.headers.has("origin") || request.headers.has("sec-fetch-site");
		if (who.ambient && browser && !hasCsrf(request) && who.principal.scope !== "read") return { ...who.principal, scope: "read" };
		return who.principal;
	};

	const linkOrigin = (request: Request) => publicOrigin ?? new URL(request.url).origin;
	const links = (request: Request): Links => ({
		profileBase: (id) => {
			if (auth === "none") return `${linkOrigin(request)}/profiles/${id}`;
			// External tools (the Firefox Profiler) fetch without credentials: sign the path instead.
			const expires = Math.ceil(Date.now() / 3_600_000 + LINK_HOURS) * 3600;
			return `${linkOrigin(request)}/profiles/${id}/s/${expires}.${sign(`profile:${id}:${expires}`)}`;
		},
	});
	const validSignature = (id: number, signature: string) => {
		const [expires, mac] = signature.split(".");
		if (!expires || !mac || Number(expires) * 1000 < Date.now()) return false;
		const expected = Buffer.from(sign(`profile:${id}:${expires}`));
		const supplied = Buffer.from(mac);
		return supplied.length === expected.length && timingSafeEqual(supplied, expected);
	};

	const yoga = createYoga<{ principal: Principal | null; links: Links }, Context>({
		schema: createSchema(),
		// A fresh context per request: its loaders batch and memoize lookups within that request only.
		context: ({ principal, links }) => createContext(store, principal, links),
		graphqlEndpoint: "/graphql",
		landingPage: false,
		logging: "warn",
		maskedErrors: false,
		// No CORS headers at all: browsers keep other origins from reading responses.
		cors: false,
	});
	const profiles = profileRoutes(store, validSignature);

	const rpc = async (request: Request, method: string, who: Principal | null): Promise<Response> => {
		if (request.method !== "POST") return failure(405, "Use POST.");
		if (!Object.hasOwn(METHODS, method)) return failure(404, `Unknown method ${method}.`);
		const spec = METHODS[method as MethodName];
		if (!allows(who?.scope ?? null, spec.scope)) {
			return who ? failure(403, `${method} needs ${spec.scope} access; ${who.name} has ${who.scope} access.`)
				: failure(401, "Authentication required.");
		}
		let args: unknown[];
		try {
			const parsed = spec.args.safeParse(await decodeArgs(request));
			if (!parsed.success) return failure(400, `Invalid arguments for ${method}: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
			args = parsed.data as unknown[];
		} catch (error) {
			return failure(400, `Unreadable request: ${(error as Error).message}`);
		}
		const backend = new LocalBackend(store, { webUrl: linkOrigin(request), principal: who!, links: links(request), remote: true });
		try {
			return json(200, { result: await backend.invoke(method as MethodName, args) });
		} catch (error) {
			return failure(422, (error as Error).message);
		}
	};

	const session = async (request: Request, who: Caller): Promise<Response> => {
		if (request.method === "POST") {
			if (auth === "none") return failure(400, "This server does not use sign-in.");
			const body = (await request.json().catch(() => null)) as { token?: unknown } | null;
			const principal = typeof body?.token === "string" ? authenticate(store, body.token.trim()) : null;
			if (!principal) return failure(401, "Invalid or revoked API token.");
			return json(200, describe(principal), { "set-cookie": sessionCookie((body!.token as string).trim(), SESSION_DAYS * 86_400) });
		}
		if (request.method === "DELETE") return json(200, describe(null), { "set-cookie": sessionCookie("", 0) });
		return json(200, describe(who.principal));
	};
	const describe = (principal: Principal | null) => ({
		csrf, auth, publicRead: options.publicRead ?? false, version: VERSION,
		principal: principal && { name: principal.name, scope: principal.scope },
	});

	const handle = async (request: Request): Promise<Response> => {
		if (!hostAllowed(request.headers.get("host"))) {
			return new Response("Misdirected request.\n", { status: 421, headers: { "content-type": "text/plain" } });
		}
		const url = new URL(request.url);
		if (url.pathname === "/healthz") {
			// Liveness and readiness: the database answers.
			store.db.query("SELECT 1").get();
			return json(200, { ok: true, version: VERSION, schemaVersion: SCHEMA_VERSION });
		}
		const api = url.pathname === "/graphql" || url.pathname.startsWith("/graphql/") || url.pathname.startsWith("/api/");
		if (api && foreign(request)) return failure(403, "Cross-origin requests are not allowed.");
		const who = caller(request);
		if (who instanceof Response) return who;
		if (url.pathname === "/api/session") return session(request, who);
		const rpcMatch = /^\/api\/v1\/rpc\/([A-Za-z]+)$/.exec(url.pathname);
		if (rpcMatch) return rpc(request, rpcMatch[1], effective(request, who));
		if (api && url.pathname.startsWith("/api/")) return failure(404, "Unknown API endpoint.");
		if (api) {
			const principal = effective(request, who);
			if (!principal) return failure(401, "Authentication required.");
			return yoga.fetch(request, { principal, links: links(request) });
		}
		const profile = await profiles(request, url, who);
		if (profile) return profile;
		if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405 });
		return serveStatic(url);
	};

	if (auth === "token" && !listTokens(store).length) {
		console.error("benchboard: no API tokens exist yet; create one with `benchboard token create <name> --scope admin`.");
	}
	if (auth === "none" && !isLoopback(options.host)) {
		console.error(`benchboard: WARNING: serving ${options.host} without authentication; anyone who can reach it can change data. ` +
			"Only do this behind an authenticating proxy.");
	}

	return Bun.serve({
		hostname: options.host,
		port: options.port,
		maxRequestBodySize: options.maxRequestBodyBytes ?? 1024 * 1024 * 1024,
		// Large uploads and profile aggregation can take a while.
		idleTimeout: 255,
		async fetch(request) {
			const started = performance.now();
			const url = new URL(request.url);
			let response: Response;
			try {
				response = await handle(request);
			} catch (error) {
				console.error(`benchboard: ${request.method} ${url.pathname}: ${(error as Error).stack ?? error}`);
				response = failure(500, "Internal server error.");
			}
			if (options.accessLog && !(url.pathname === "/healthz" && response.ok)) {
				console.error(`${new Date().toISOString()} ${request.method} ${url.pathname} ${response.status} ${(performance.now() - started).toFixed(0)}ms`);
			}
			return response;
		},
	});
}

export type { Scope };
