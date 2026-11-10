import * as path from "node:path";
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
	const yoga = createYoga<{}, Context>({
		schema: createSchema(),
		context: () => ({ store }),
		graphqlEndpoint: "/graphql",
		landingPage: false,
		logging: "warn",
		maskedErrors: false,
	});
	return Bun.serve({
		hostname: options.host,
		port: options.port,
		async fetch(request) {
			if (!allowedHost(request.headers.get("host"), options.host)) {
				return new Response("Misdirected request.\n", { status: 421, headers: { "content-type": "text/plain" } });
			}
			const url = new URL(request.url);
			if (url.pathname.startsWith("/graphql")) return yoga.fetch(request, {});
			for (const route of options.routes ?? []) {
				const response = await route(request, url);
				if (response) return response;
			}
			if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405 });
			return serveStatic(url);
		},
	});
}
