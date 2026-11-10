import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createYoga } from "graphql-yoga";
import { createSchema, type Context } from "@benchboard/graphql";
import type { Store } from "@benchboard/core";

export const DEFAULT_PORT = 4319;

const webRoot = fileURLToPath(new URL("../../../apps/web/dist/", import.meta.url));
const types: Record<string, string> = {
	".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
	".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json",
	".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8",
};

/** Rejects requests addressed to other hostnames, which blocks DNS-rebinding access to local data. */
function allowedHost(host: string | undefined, bound: string): boolean {
	if (!host) return false;
	const name = host.replace(/:\d+$/, "").replace(/^\[|\]$/g, "").toLowerCase();
	return ["localhost", "127.0.0.1", "::1"].includes(name) || name === bound.toLowerCase();
}

function serveStatic(request: http.IncomingMessage, response: http.ServerResponse) {
	const url = new URL(request.url ?? "/", "http://localhost");
	let file = path.normalize(path.join(webRoot, decodeURIComponent(url.pathname)));
	if (!file.startsWith(webRoot)) { response.writeHead(403).end(); return; }
	if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(webRoot, "index.html");
	if (!fs.existsSync(file)) {
		response.writeHead(503, { "content-type": "text/plain; charset=utf-8" })
			.end("The web app is not built. Run `pnpm build` in the benchboard repository, or use `pnpm dev`.\nGraphQL is available at /graphql.\n");
		return;
	}
	const immutable = file.includes(`${path.sep}assets${path.sep}`);
	response.writeHead(200, {
		"content-type": types[path.extname(file)] ?? "application/octet-stream",
		"cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
	});
	fs.createReadStream(file).pipe(response);
}

export function createServer(store: Store, host: string) {
	const yoga = createYoga<{}, Context>({
		schema: createSchema(),
		context: () => ({ store }),
		graphqlEndpoint: "/graphql",
		landingPage: false,
		logging: "warn",
		maskedErrors: false,
	});
	return http.createServer((request, response) => {
		if (!allowedHost(request.headers.host, host)) {
			response.writeHead(421, { "content-type": "text/plain" }).end("Misdirected request.\n");
			return;
		}
		if (request.url?.startsWith("/graphql")) {
			void yoga(request, response);
			return;
		}
		if (request.method !== "GET" && request.method !== "HEAD") { response.writeHead(405).end(); return; }
		serveStatic(request, response);
	});
}
