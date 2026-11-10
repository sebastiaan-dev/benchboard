import * as fs from "node:fs";
import { symbolicateRequest, type Store, type SymsSidecar } from "@benchboard/core";
import type { Route } from "./server.ts";

/**
 * The Firefox Profiler (https://profiler.firefox.com) fetches profiles and symbols directly from
 * this local server, like `samply load` does. Only that origin gets CORS access, and Chrome's
 * Private Network Access preflight is answered explicitly.
 */
const PROFILER_ORIGIN = "https://profiler.firefox.com";

function cors(request: Request, headers: Record<string, string> = {}): Headers {
	const result = new Headers(headers);
	const origin = request.headers.get("origin");
	if (origin === PROFILER_ORIGIN) {
		result.set("access-control-allow-origin", origin);
		result.set("vary", "origin");
		result.set("access-control-allow-private-network", "true");
		result.set("access-control-allow-methods", "GET, POST, OPTIONS");
		result.set("access-control-allow-headers", "content-type");
	}
	return result;
}

export function profileRoutes(store: Store): Route {
	const symsCache = new Map<string, SymsSidecar>();
	return async (request, url) => {
		const match = /^\/profiles\/(\d+)\/(profile\.json\.gz|symbols\/(symbolicate\/v5|source\/v1|asm\/v1))$/.exec(url.pathname);
		if (!match) return undefined;
		if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(request) });
		const profile = store.profile(Number(match[1]));
		if (!profile) return new Response("Unknown profile.\n", { status: 404, headers: cors(request) });
		if (match[2] === "profile.json.gz") {
			if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405 });
			return new Response(Bun.file(store.profileFile(profile)), {
				headers: cors(request, {
					"content-type": "application/octet-stream",
					"content-disposition": `attachment; filename="profile-${profile.id}.json.gz"`,
					"cache-control": "private, max-age=31536000, immutable",
				}),
			});
		}
		if (match[3] !== "symbolicate/v5") return new Response("Not available.\n", { status: 404, headers: cors(request) });
		if (request.method !== "POST") return new Response(null, { status: 405 });
		const file = store.profileSymsFile(profile);
		if (!file || !fs.existsSync(file)) {
			return Response.json({ results: [] }, { headers: cors(request) });
		}
		let syms = symsCache.get(file);
		if (!syms) {
			syms = JSON.parse(fs.readFileSync(file, "utf8")) as SymsSidecar;
			if (symsCache.size > 16) symsCache.clear();
			symsCache.set(file, syms);
		}
		const body = await request.json().catch(() => null);
		return Response.json(symbolicateRequest(syms, body), { headers: cors(request) });
	};
}
