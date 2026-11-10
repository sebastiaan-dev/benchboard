import * as path from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createYoga } from "graphql-yoga";
import { createSchema, type Context } from "@benchboard/graphql";
import type { Store } from "@benchboard/core";

export const DEFAULT_PORT = 4319;

const webRoot = fileURLToPath(new URL("../../../apps/web/dist/", import.meta.url));

/** Rejects requests addressed to other hostnames, which blocks DNS-rebinding access to local data. */
function allowedHost(host: string | null, bound: string): boolean {
	if (!host) return false;
	const name = host.replace(/:\d+$/, "").replace(/^\[|\]$/g, "").toLowerCase();
	return ["localhost", "127.0.0.1", "::1"].includes(name) || name === bound.toLowerCase();
}

/** Origins allowed to call the API from a browser: this server itself plus explicitly configured ones (e.g. Vite dev). */
function allowedOrigins(host: string, port: number): Set<string> {
	const names = new Set(["localhost", "127.0.0.1", "[::1]", host.includes(":") ? `[${host}]` : host]);
	const extra = (process.env.BENCHBOARD_ALLOWED_ORIGINS ?? "").split(",").map((entry) => entry.trim().replace(/\/+$/, "")).filter(Boolean);
	return new Set([...[...names].map((name) => `http://${name}:${port}`), ...extra]);
}

const json = (status: number, body: unknown) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

async function serveStatic(url: URL): Promise<Response> {
	const file = path.normalize(path.join(webRoot, decodeURIComponent(url.pathname)));
	if (!file.startsWith(webRoot)) return new Response(null, { status: 403 });
	let asset = Bun.file(file);
	// Client-side routes fall back to the SPA shell.
	if (url.pathname.endsWith("/") || !(await asset.exists())) asset = Bun.file(path.join(webRoot, "index.html"));
	if (!(await asset.exists())) {
		return new Response("The web app is not built. Run `bun run build` in the benchboard repository, or use `bun run dev`.\nGraphQL is available at /graphql.\n",
			{ status: 503, headers: { "content-type": "text/plain; charset=utf-8" } });
	}
	const immutable = url.pathname.startsWith("/assets/");
	return new Response(asset, { headers: { "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache" } });
}

export type Route = (request: Request, url: URL) => Response | undefined | Promise<Response | undefined>;

export function createServer(store: Store, options: { host: string; port: number; routes?: Route[] }) {
	// A per-process secret: only same-origin pages can read it (no CORS), so cross-site pages cannot mutate.
	const token = randomBytes(24).toString("hex");
	const tokenBytes = Buffer.from(token);
	const origins = allowedOrigins(options.host, options.port);
	const hasToken = (request: Request) => {
		const supplied = Buffer.from(request.headers.get("x-benchboard-token") ?? "");
		return supplied.length === tokenBytes.length && timingSafeEqual(supplied, tokenBytes);
	};
	const yoga = createYoga<{ mayMutate: boolean }, Context>({
		schema: createSchema(),
		context: ({ mayMutate }) => ({ store, mayMutate }),
		graphqlEndpoint: "/graphql",
		landingPage: false,
		logging: "warn",
		maskedErrors: false,
		// No CORS headers at all: browsers keep other origins from reading responses.
		cors: false,
	});
	/**
	 * Browser requests from other origins are refused outright, before any resolver runs. Origin is
	 * sent with every cross-origin request (and with same-origin POSTs); Sec-Fetch-Site covers the rest.
	 */
	const foreign = (request: Request) => {
		const origin = request.headers.get("origin");
		if (origin !== null && !origins.has(origin)) return true;
		const site = request.headers.get("sec-fetch-site");
		return site === "cross-site" || (site === "same-site" && origin === null);
	};
	return Bun.serve({
		hostname: options.host,
		port: options.port,
		async fetch(request) {
			if (!allowedHost(request.headers.get("host"), options.host)) {
				return new Response("Misdirected request.\n", { status: 421, headers: { "content-type": "text/plain" } });
			}
			const url = new URL(request.url);
			if (url.pathname === "/graphql" || url.pathname.startsWith("/graphql/") || url.pathname === "/api/session") {
				if (foreign(request)) return json(403, { errors: [{ message: "Cross-origin requests are not allowed." }] });
				if (url.pathname === "/api/session") return json(200, { token });
				return yoga.fetch(request, { mayMutate: hasToken(request) });
			}
			for (const route of options.routes ?? []) {
				const response = await route(request, url);
				if (response) return response;
			}
			if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405 });
			return serveStatic(url);
		},
	});
}
