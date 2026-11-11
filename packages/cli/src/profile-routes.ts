import * as fs from "node:fs";
import { symbolicateRequest, type Store, type SymsSidecar } from "@benchboard/core";
import type { Route } from "./server.ts";

/**
 * The Firefox Profiler (https://profiler.firefox.com) fetches profiles and symbols directly from this
 * server, like `samply load` does. Only that origin gets CORS access, and Chrome's Private Network
 * Access preflight is answered explicitly. It sends no credentials, so on servers that require them
 * it uses signed, expiring paths (`/profiles/<id>/s/<signature>/…`) handed out to signed-in users.
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

export function profileRoutes(store: Store, validSignature: (id: number, signature: string) => boolean): Route {
	const symsCache = new Map<string, SymsSidecar>();
	return async (request, url, caller) => {
		const match = /^\/profiles\/(\d+)\/(?:s\/([\w.-]+)\/)?(profile\.json\.gz|symbols\/(symbolicate\/v5|source\/v1|asm\/v1))$/.exec(url.pathname);
		if (!match) return undefined;
		if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(request) });
		const id = Number(match[1]);
		const signed = match[2] !== undefined;
		if (signed ? !validSignature(id, match[2]) : !caller.principal) {
			return new Response(signed ? "This link has expired; open the profile from Benchboard again.\n" : "Authentication required.\n",
				{ status: signed ? 403 : 401, headers: cors(request) });
		}
		const profile = store.profile(id);
		if (!profile) return new Response("Unknown profile.\n", { status: 404, headers: cors(request) });
		if (match[3] === "profile.json.gz") {
			if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405 });
			return new Response(Bun.file(store.profileFile(profile)), {
				headers: cors(request, {
					"content-type": "application/octet-stream",
					"content-disposition": `attachment; filename="profile-${profile.id}.json.gz"`,
					"cache-control": "private, max-age=31536000, immutable",
				}),
			});
		}
		if (match[4] !== "symbolicate/v5") return new Response("Not available.\n", { status: 404, headers: cors(request) });
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
