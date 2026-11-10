import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const bin = fileURLToPath(new URL("../bin/benchboard.ts", import.meta.url));

function setup(t: { after: (fn: () => void) => void }) {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "benchboard-cli-")));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const repo = path.join(root, "repo");
	const home = path.join(root, "home");
	fs.mkdirSync(repo);
	const env = {
		...process.env, BENCHBOARD_HOME: home,
		GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@e", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@e",
	};
	const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", env }).trim();
	git("init", "-q", "-b", "main");
	fs.writeFileSync(path.join(repo, "src"), "0");
	git("add", ".");
	git("commit", "-qm", "base");
	git("checkout", "-qb", "topic");
	fs.writeFileSync(path.join(repo, "src"), "1");
	git("commit", "-qam", "make it slower");
	const cli = (...args: string[]): { code: number; stdout: string; stderr: string } => {
		try {
			return { code: 0, stdout: execFileSync(process.execPath, [bin, ...args], { cwd: repo, env, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }), stderr: "" };
		} catch (error) {
			const failure = error as { status: number; stdout: string; stderr: string };
			return { code: failure.status, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
		}
	};
	return { root, repo, home, env, git, cli };
}

const series = (center: number, n = 20) => Array.from({ length: n }, (_, i) => center * (1 + ((i * 7919) % 13 - 6) / 600));

test("CLI: ingest a base/head sweep, track the branch and report", (t) => {
	const { root, git, cli } = setup(t);
	const exportFile = path.join(root, "bench.json");
	fs.writeFileSync(exportFile, JSON.stringify({
		results: [
			{ command: "./old", times: series(1), exit_codes: series(1).map(() => 0) },
			{ command: "./new", times: series(1.25), exit_codes: series(1).map(() => 0) },
		],
	}));
	const meta = path.join(root, "meta.json");
	fs.writeFileSync(meta, JSON.stringify({
		benchmark: "cli/sweep", title: "Sweep", baseline: 1,
		cases: [{ case: "work", commit: "main" }, { case: "work", commit: "HEAD" }],
	}));
	const ingest = cli("ingest", exportFile, "--meta", meta, "--track-branch", "--base", "main", "--json");
	assert.equal(ingest.code, 0, ingest.stderr);
	const result = JSON.parse(ingest.stdout);
	assert.equal(result.measurements[0].commitSha, git("rev-parse", "main"));
	assert.equal(result.measurements[1].commitSha, git("rev-parse", "HEAD"));
	assert.equal(result.pullRequests[0].headRef, "topic");

	const report = JSON.parse(cli("pr", "report", "topic", "--json").stdout);
	assert.equal(report.summary.regression, 1);
	assert.ok(report.series[0].latestComparison.sameRun);
	const text = cli("pr", "report", "topic").stdout;
	assert.match(text, /1 regressions/);
	assert.match(text, /cli\/sweep \/ work/);

	const query = cli("query", "query ($id: ID!) { pullRequest(id: $id) { title report { summary { regressions } } } }", "--variables", JSON.stringify({ id: result.pullRequests[0].id }));
	assert.equal(query.code, 0, query.stderr);
	assert.deepEqual(JSON.parse(query.stdout).data.pullRequest, { title: "topic", report: { summary: { regressions: 1 } } });

	const duplicate = cli("ingest", exportFile, "--meta", meta);
	assert.equal(duplicate.code, 1);
	assert.match(duplicate.stderr, /already ingested/);
	const invalid = cli("ingest", exportFile, "--benchmark", "Not A Key");
	assert.equal(invalid.code, 1);
	assert.match(invalid.stderr, /benchmark: Use lowercase/);
});

test("CLI: serve exposes GraphQL on localhost only", async (t) => {
	const { cli, env, repo } = setup(t);
	assert.equal(cli("pr", "track", "--branch", "--base", "main").code, 0);
	const port = 43000 + Math.floor(Math.random() * 1000);
	const server = spawn(process.execPath, [bin, "serve", "--port", String(port)], { cwd: repo, env, stdio: ["ignore", "ignore", "pipe"] });
	t.after(() => server.kill());
	await new Promise<void>((resolve, reject) => {
		server.stderr.on("data", (chunk: Buffer) => chunk.toString().includes("serving") && resolve());
		server.once("exit", (code) => reject(new Error(`server exited with ${code}`)));
	});
	const response = await fetch(`http://127.0.0.1:${port}/graphql`, {
		method: "POST", headers: { "content-type": "application/json" },
		body: JSON.stringify({ query: "{ repositories { name pullRequests { headRef commits { subject } } } }" }),
	});
	const body = await response.json() as { data: { repositories: { pullRequests: { headRef: string; commits: { subject: string }[] }[] }[] } };
	assert.deepEqual(body.data.repositories[0].pullRequests[0], { headRef: "topic", commits: [{ subject: "make it slower" }] });
	// fetch cannot override Host, so use node:http to simulate a DNS-rebinding request.
	const status = await new Promise<number | undefined>((resolve, reject) => {
		http.request({ port, path: "/graphql", headers: { host: "attacker.example" } }, (res) => { res.resume(); resolve(res.statusCode); })
			.on("error", reject).end();
	});
	assert.equal(status, 421);
});
