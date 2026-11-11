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

/** A minimal GitHub REST API: one pull request whose commits are the test repository's topic branch. */
function fakeGithub(scope: { after: (fn: () => void) => void }, git: (...args: string[]) => string) {
	const commit = (sha: string) => {
		const [parents, subject, date] = git("show", "-s", "--format=%P%x1f%s%x1f%cI", sha).split("\x1f");
		return { sha, parents: parents.split(" ").filter(Boolean).map((parent) => ({ sha: parent })), author: null, commit: { message: subject, author: { name: "T", date }, committer: { date } } };
	};
	const server = Bun.serve({
		port: 0,
		fetch(request) {
			const route = new URL(request.url).pathname;
			if (route === "/repos/acme/engine/pulls/7") {
				return Response.json({ number: 7, title: "Make it slower", html_url: "https://github.com/acme/engine/pull/7", state: "open", merged_at: null,
					updated_at: "2026-11-11T00:00:00Z", user: { login: "dev" }, head: { ref: "topic", sha: git("rev-parse", "topic") }, base: { ref: "main", sha: git("rev-parse", "main") } });
			}
			if (route === "/repos/acme/engine/pulls/7/commits") return Response.json([commit(git("rev-parse", "topic"))]);
			if (route.startsWith("/repos/acme/engine/commits/")) return Response.json(commit(route.split("/").pop()!));
			return Response.json({ message: "Not Found" }, { status: 404 });
		},
	});
	scope.after(() => server.stop(true));
	return `http://127.0.0.1:${server.port}`;
}

test("server: unreachable servers queue uploads, push delivers them once; runners track PRs through the server", async () => {
	const { root, repo, env, cli, cliAsync, git } = setup(t);
	git("remote", "add", "origin", "https://github.com/acme/engine.git");
	const github = fakeGithub(t, git);
	// The server can reach GitHub; the runner cannot (and has no gh login to fall back on).
	const serverEnv = { ...env, GITHUB_API_URL: github, GH_TOKEN: "server-token" };
	let server = await startServer(t, serverEnv, repo, ["--auth", "token"]);
	const token = cli("token", "create", "runner", "--scope", "write").stdout.trim();
	const runner = cliAsync({ BENCHBOARD_HOME: undefined, BENCHBOARD_SERVER: server.url, BENCHBOARD_TOKEN: token, BENCHBOARD_RETRIES: "0",
		XDG_STATE_HOME: path.join(root, "state"), GITHUB_API_URL: "http://127.0.0.1:9", GH_TOKEN: "runner-token" });
	const exportFile = path.join(root, "bench.json");
	fs.writeFileSync(exportFile, JSON.stringify({ results: [
		{ command: "./old", times: series(1), exit_codes: series(1).map(() => 0) },
		{ command: "./new", times: series(1.25), exit_codes: series(1).map(() => 0) },
	] }));
	const meta = path.join(root, "meta.json");
	fs.writeFileSync(meta, JSON.stringify({ benchmark: "tpch/q1", cases: [{ case: "q1", commit: "main" }, { case: "q1", commit: "topic" }] }));

	// Server down: nothing is lost.
	await server.stop();
	const queued = await runner("ingest", exportFile, "--meta", meta, "--pr", "7");
	assert.equal(queued.code, 4, queued.stderr);
	assert.match(queued.stderr, /Cannot reach[\s\S]*benchboard push/);
	const outbox = path.join(root, "state", "benchboard", "outbox");
	const [entry] = fs.readdirSync(outbox);
	assert.ok(fs.existsSync(path.join(outbox, entry, "blob-0")), "the export travels as a file");
	assert.match((await runner("push")).stderr, /kept; push again later/);

	// Back up (same port, same data): push delivers the run and asks the server to track the PR.
	server = await startServer(t, serverEnv, repo, ["--auth", "token"], server.port);
	fs.cpSync(path.join(outbox, entry), path.join(root, "copy"), { recursive: true });
	const pushed = await runner("push");
	assert.equal(pushed.code, 0, pushed.stderr);
	assert.match(pushed.stdout, /Pushed run/);
	assert.deepEqual(fs.readdirSync(outbox), []);
	// Delivering the same entry again (e.g. the first response was lost) does not duplicate the run.
	fs.cpSync(path.join(root, "copy"), path.join(outbox, entry), { recursive: true });
	assert.equal((await runner("push")).code, 0);
	const runs = JSON.parse((await runner("runs", "--all", "--json")).stdout);
	assert.equal(runs.length, 1);

	// The PR was fetched by the server with its own GitHub access.
	const prs = JSON.parse((await runner("pr", "list", "--all", "--json")).stdout);
	assert.deepEqual(prs.map((pr: { title: string; number: number }) => [pr.number, pr.title]), [[7, "Make it slower"]]);
	assert.match((await runner("pr", "track", "7")).stdout, /Tracking acme\/engine#7 .* with 1 commits/);

	// A terminal view of the run, with the in-run comparison.
	const show = await runner("run", "show", "latest");
	assert.equal(show.code, 0, show.stderr);
	assert.match(show.stdout, /tpch\/q1\/q1 .* \+25\.00% .* regression vs #1/);
	assert.match(show.stdout, new RegExp(`${server.url}/runs/${runs[0].id}`));
});
