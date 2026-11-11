import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach } from "bun:test";
import { fileURLToPath } from "node:url";

// node:test-style cleanup registration on top of bun:test.
const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });
export const t = { after: (fn: () => void) => { cleanups.push(fn); } };

export const bin = fileURLToPath(new URL("../bin/benchboard.ts", import.meta.url));

export type Cli = (...args: string[]) => { code: number; stdout: string; stderr: string };

/** A temporary git repository (main: "base", topic: "make it slower") and a CLI bound to it. */
export function setup(scope: { after: (fn: () => void) => void } = t, extraEnv: Record<string, string | undefined> = {}) {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "benchboard-cli-")));
	scope.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const repo = path.join(root, "repo");
	const home = path.join(root, "home");
	fs.mkdirSync(repo);
	const env: Record<string, string | undefined> = {
		...process.env, BENCHBOARD_HOME: home, XDG_CONFIG_HOME: path.join(root, "config"),
		BENCHBOARD_SERVER: undefined, BENCHBOARD_TOKEN: undefined,
		GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@e", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@e",
		...extraEnv,
	};
	const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", env }).trim();
	git("init", "-q", "-b", "main");
	fs.writeFileSync(path.join(repo, "src"), "0");
	git("add", ".");
	git("commit", "-qm", "base");
	git("checkout", "-qb", "topic");
	fs.writeFileSync(path.join(repo, "src"), "1");
	git("commit", "-qam", "make it slower");
	const run = (environment: Record<string, string | undefined>): Cli => (...args) => {
		try {
			return { code: 0, stdout: execFileSync(process.execPath, [bin, ...args], { cwd: repo, env: environment, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }), stderr: "" };
		} catch (error) {
			const failure = error as { status: number; stdout: string; stderr: string };
			return { code: failure.status, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
		}
	};
	const cli = run(env);
	/** The same CLI with other environment variables, e.g. to talk to a server. */
	const cliWith = (overrides: Record<string, string | undefined>) => run({ ...env, ...overrides });
	/** Like cliWith, without blocking this process (needed when it serves something the CLI calls). */
	const cliAsync = (overrides: Record<string, string | undefined>) => async (...args: string[]) => {
		const child = Bun.spawn([process.execPath, bin, ...args], { cwd: repo, env: { ...env, ...overrides }, stdout: "pipe", stderr: "pipe" });
		const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
		return { code, stdout, stderr };
	};
	return { root, repo, home, env, git, cli, cliWith, cliAsync };
}

export const series = (center: number, n = 20) => Array.from({ length: n }, (_, i) => center * (1 + ((i * 7919) % 13 - 6) / 600));

/** Starts `benchboard serve` and resolves once it listens. */
export async function startServer(scope: { after: (fn: () => void) => void }, env: Record<string, string | undefined>, cwd: string, args: string[] = [],
	port = 43000 + Math.floor(Math.random() * 2000)) {
	const server = spawn(process.execPath, [bin, "serve", "--port", String(port), ...args], { cwd, env, stdio: ["ignore", "ignore", "pipe"] });
	scope.after(() => server.kill());
	let log = "";
	await new Promise<void>((resolve, reject) => {
		server.stderr.on("data", (chunk: Buffer) => {
			log += chunk.toString();
			if (log.includes("serving")) resolve();
		});
		server.once("exit", (code) => reject(new Error(`server exited with ${code}: ${log}`)));
	});
	const stopped = new Promise<void>((resolve) => server.once("exit", () => resolve()));
	return { port, url: `http://127.0.0.1:${port}`, process: server, log: () => log, stop: () => { server.kill(); return stopped; } };
}

export { assert };
