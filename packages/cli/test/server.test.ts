import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "bun:test";
import { series, setup, startServer, t } from "./helpers.ts";
import { syntheticProfile } from "../../core/test/synthetic-profile.ts";

/**
 * A server with token auth, used the way a deployment is: tokens created on the server host, a
 * benchmark machine ingesting with the CLI over HTTP, and a browser signing in with a cookie.
 */
test("server: remote ingest, scoped tokens, browser sessions, signed profile links and backups", async () => {
	const { root, repo, home, env, cli, cliWith } = setup(t);
	const server = await startServer(t, env, repo, ["--auth", "token"]);
	const url = server.url;
	assert.match(server.log(), /no API tokens exist yet/);

	// Tokens are created on the server host, against its data directory.
	const token = (name: string, scope: string) => {
		const created = cli("token", "create", name, "--scope", scope);
		assert.equal(created.code, 0, created.stderr);
		return created.stdout.trim();
	};
	const writer = token("bench-m5", "write");
	const reader = token("dashboard", "read");
	assert.match(cli("token", "create", "bench-m5").stderr, /active token named "bench-m5" exists/);
	assert.match(cli("token", "list").stdout, /bench-m5\twrite\tbb_/);

	// The benchmark machine has no data directory of its own: everything goes to the server.
	const client = cliWith({ BENCHBOARD_HOME: undefined, BENCHBOARD_SERVER: url, BENCHBOARD_TOKEN: writer });
	const { profile, syms } = syntheticProfile("engine", [{ name: "worker", stacks: [{ frames: ["main", "Probe"], samples: 20 }] }]);
	fs.writeFileSync(path.join(root, "head.json.gz"), Bun.gzipSync(new TextEncoder().encode(JSON.stringify(profile))));
	fs.writeFileSync(path.join(root, "head.json.syms.json"), JSON.stringify(syms));
	const exportFile = path.join(root, "bench.json");
	fs.writeFileSync(exportFile, JSON.stringify({ results: [
		{ command: "./old", times: series(1), exit_codes: series(1).map(() => 0) },
		{ command: "./new", times: series(1.25), exit_codes: series(1).map(() => 0) },
	] }));
	const meta = path.join(root, "meta.json");
	fs.writeFileSync(meta, JSON.stringify({ benchmark: "tpch/q1", cases: [
		{ case: "q1", commit: "main" }, { case: "q1", commit: "HEAD", profile: path.join(root, "head.json.gz") },
	] }));
	const ingest = client("ingest", exportFile, "--meta", meta, "--track-branch", "--base", "main", "--json");
	assert.equal(ingest.code, 0, ingest.stderr);
	const result = JSON.parse(ingest.stdout);
	assert.equal(result.url, `${url}/runs/${result.run.id}`);
	assert.equal(result.pullRequests[0].headRef, "topic");
	assert.equal(result.repository.localPath, null, "client checkout paths are not the server's");
	assert.equal(result.run.checkoutPath, repo, "but stay as provenance");

	const report = client("pr", "report", "topic");
	assert.equal(report.code, 0, report.stderr);
	assert.match(report.stdout, /1 regressions/);
	assert.match(report.stdout, /make it slower/);
	assert.match(client("pr", "list").stdout, /branch topic/);
	assert.match(client("profile", "show", "1").stdout, /Probe/);
	assert.equal(client("pr", "sync", "topic").code, 0);
	assert.match(client("whoami").stdout, new RegExp(`${url}: bench-m5 \\(write\\)`));

	// Scopes: read tokens cannot write; no or bad credentials get nothing.
	const readOnly = cliWith({ BENCHBOARD_HOME: undefined, BENCHBOARD_SERVER: url, BENCHBOARD_TOKEN: reader });
	assert.match(readOnly("ingest", exportFile, "--allow-duplicate").stderr, /ingest needs write access; dashboard has read access/);
	assert.equal(readOnly("runs").code, 0);
	assert.match(cliWith({ BENCHBOARD_HOME: undefined, BENCHBOARD_SERVER: url })("runs").stderr, /Authentication required/);
	const graphql = (headers: Record<string, string>, query: string) => fetch(`${url}/graphql`, {
		method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ query }),
	});
	assert.equal((await graphql({}, "{ runs { id } }")).status, 401);
	assert.equal((await graphql({ authorization: "Bearer bb_wrong" }, "{ runs { id } }")).status, 401);
	assert.equal((await fetch(`${url}/healthz`)).status, 200, "health checks need no credentials");

	// `login` saves the server and token for later commands.
	const login = cliWith({ BENCHBOARD_HOME: undefined, BENCHBOARD_TOKEN: undefined });
	assert.equal(login("login", url, "--token", reader).code, 0);
	assert.match(login("whoami").stdout, /dashboard \(read\)/);

	// Browsers sign in with a token and get an HttpOnly session cookie; writes also need the CSRF token.
	const origin = { origin: url };
	const signIn = await fetch(`${url}/api/session`, { method: "POST", headers: { "content-type": "application/json", ...origin }, body: JSON.stringify({ token: writer }) });
	assert.equal(signIn.status, 200);
	const setCookie = signIn.headers.get("set-cookie")!;
	assert.match(setCookie, /bb_session=.*HttpOnly; SameSite=Lax/);
	const cookie = setCookie.split(";")[0];
	const session = await (await fetch(`${url}/api/session`, { headers: { cookie } })).json() as { csrf: string; principal: { name: string } };
	assert.equal(session.principal.name, "bench-m5");
	const sync = `mutation { syncPullRequest(id: ${result.pullRequests[0].id}) { id } }`;
	const withoutCsrf = await (await graphql({ cookie, ...origin }, sync)).json() as { errors: { message: string }[] };
	assert.match(withoutCsrf.errors[0].message, /needs write access; bench-m5 has read access/);
	const withCsrf = await (await graphql({ cookie, ...origin, "x-benchboard-csrf": session.csrf }, sync)).json() as { errors: { message: string }[] };
	// Accepted, but a server has no checkout to read a local branch from.
	assert.match(withCsrf.errors[0].message, /Local branches are synced from a checkout/);
	const foreign = await fetch(`${url}/api/session`, { method: "POST", headers: { "content-type": "application/json", origin: "https://evil.example" }, body: "{}" });
	assert.equal(foreign.status, 403);

	// The Firefox Profiler fetches without credentials, through signed, expiring links.
	const linked = await (await graphql({ cookie }, "{ profile(id: 1) { firefoxProfilerUrl } }")).json() as { data: { profile: { firefoxProfilerUrl: string } } };
	const raw = decodeURIComponent(/from-url\/([^/]+)\//.exec(linked.data.profile.firefoxProfilerUrl)![1]);
	assert.match(raw, new RegExp(`^${url}/profiles/1/s/\\d+\\.[\\w-]+/profile\\.json\\.gz$`));
	assert.equal((await fetch(raw)).status, 200);
	assert.equal((await fetch(raw.replace(/\.[\w-]+\/profile/, ".forged/profile"))).status, 403);
	assert.equal((await fetch(`${url}/profiles/1/profile.json.gz`)).status, 401);
	assert.equal((await fetch(`${url}/profiles/1/profile.json.gz`, { headers: { cookie } })).status, 200);

	// Revoked tokens stop working immediately.
	assert.equal(cli("token", "revoke", "dashboard").code, 0);
	assert.equal((await graphql({ authorization: `Bearer ${reader}` }, "{ runs { id } }")).status, 401);

	// Backups are consistent while the server runs, incremental, and verifiable.
	const destination = path.join(root, "backup");
	const first = JSON.parse(cli("backup", destination, "--json").stdout);
	assert.ok(first.copied >= 3, "export, profile and symbols");
	assert.equal(JSON.parse(cli("backup", destination, "--json").stdout).copied, 0);
	const verified = cliWith({ BENCHBOARD_HOME: destination })("verify", "--json");
	assert.equal(verified.code, 0, verified.stdout);
	assert.deepEqual(JSON.parse(verified.stdout).counts, { runs: 1, measurements: 2, profiles: 1, pullRequests: 1 });
	fs.rmSync(path.join(destination, "profiles"), { recursive: true });
	assert.equal(cliWith({ BENCHBOARD_HOME: destination })("verify").code, 1);
	assert.equal(fs.statSync(path.join(home, "secret.key")).mode & 0o777, 0o600);
});
