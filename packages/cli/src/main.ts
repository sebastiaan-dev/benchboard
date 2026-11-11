import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { parseArgs, stripVTControlCharacters, styleText } from "node:util";
import { spawn } from "node:child_process";
import {
	Store, backup, createToken, defaultHome, restore, githubRemotes, importLegacy, listTokens, parsePullRequestReference, parseScope, prepareProfile,
	prepareRun, repositoryIdentity, resolveCommit, revokeToken, snapshotGithubPullRequest, snapshotLocalBranch, verify,
	type Comparison, type Measurement, type Profile, type PullRequest, type PullRequestSnapshot,
} from "@benchboard/core";
import { typeDefs } from "@benchboard/graphql";
import { LocalBackend, VERSION, type Backend, type ReportBundle, type RunDetail } from "./backend.ts";
import { HttpError, RemoteBackend } from "./remote.ts";
import { enqueue, outboxDir, pending, recordError, remove, type Operation } from "./outbox.ts";
import { readLogin, removeLogin, resolveTarget, saveLogin, configFile } from "./config.ts";
import { createServer, DEFAULT_PORT, serverOptionsFromEnv } from "./server.ts";
import { samplyChecks, samplyFailureHint, samplyProblem } from "./samply.ts";

const HELP = `benchboard — track Hyperfine benchmarks across commits and pull requests

Usage:
  benchboard ingest <export.json> [options]   Save a Hyperfine --export-json file
      --meta <file|->        Metadata JSON (benchmark, title, conditions, cases[{case, commit, dirty, ...}])
      --benchmark <key>      Stable benchmark key, e.g. variant/strip-nulls
      --title <text>         Human-readable title
      --commit <rev>         Revision measured by every case (default: checkout HEAD)
      --dirty | --clean      Whether the measured build had uncommitted changes
      --pr <ref>             Also track a GitHub PR (123, owner/name#123, URL); if tracking
                             fails the run stays saved and the exit code is 3
      --track-branch         Also track the current branch as a local PR
      --measured-on <host>   Hostname of the machine that ran the benchmark, if not this one
      --allow-duplicate      Record an export that was already ingested
  benchboard pr track <ref>                   Track a GitHub pull request
  benchboard pr track --branch [name] [--base <ref>]
                                              Track a local branch (commits in base..branch)
  benchboard pr sync <ref>                    Refresh a tracked PR's commits
  benchboard pr list [--all]                  Tracked PRs for this repository
  benchboard pr report <ref> [options]        Commit-by-commit comparison against the PR base
      --statistic median|mean   --threshold <percent>   --machine <id>   --include-dirty
  benchboard profile attach <run>[:<case>] <profile.json.gz> [--syms f] [--iterations n] [--label t]
                                              Attach a samply profile to a measured case
  benchboard profile record <run>[:<case>] [--iterations n] [--rate hz] [-- command...]
                                              Profile the case's command with samply and attach it
  benchboard profile show <id> [--limit n] [--metric cpu|sampled]
                                              Hottest functions by on-CPU (default) or sampled time
  benchboard profile diff <base-id> <head-id> [--limit n] [--metric cpu|sampled]
                                              Per-function time change between two profiles
  benchboard profile check                    Whether samply can record here (Linux: perf access)
  benchboard runs [--limit n] [--all]         Recent runs
  benchboard run show <id|latest> [--statistic median|mean] [--threshold pct]
                                              Cases, medians and in-run comparisons of a run
  benchboard query <graphql|@file> [--variables <json>]
                                              Execute a GraphQL document; prints JSON
  benchboard open [pr <ref> | run <id>]       Open the dashboard (starts a local server if needed)
  benchboard import-legacy [dir]              Import pi /bench runs (~/.pi/agent/benchmarks)
  benchboard schema                           Print the GraphQL schema

Servers (see docs/deployment.md):
  benchboard login <url> [--token <t>]        Use a Benchboard server (token read from stdin if omitted)
  benchboard logout                           Forget the saved server login
  benchboard push                             Deliver uploads queued while the server was unreachable
  benchboard whoami                           Show where commands go and with which access
  benchboard serve [--host 127.0.0.1] [--port ${DEFAULT_PORT}] [--auth none|token] [--public-url <url>] [--open]
  benchboard token create <name> [--scope read|write|admin]
  benchboard token list [--all] | token revoke <id|name>
                                              Manage API tokens of the local data directory
  benchboard backup <dir> [--every 6h] [--verify]
                                              Consistent, incremental copy of the data directory
                                              (--every: keep running, refreshing it at that interval)
  benchboard restore <backup-dir> [--force]   Copy a backup into the data directory (server stopped)
  benchboard verify                           Check database integrity and stored files
  benchboard healthcheck [--port ${DEFAULT_PORT}]      Exit 0 if the local server answers (for containers)

Where commands go: --server <url> or BENCHBOARD_SERVER (token: BENCHBOARD_TOKEN or \`benchboard login\`),
else the local data directory (--home <dir>, BENCHBOARD_HOME or ~/.local/share/benchboard; --local forces it).
Common options: --cwd <dir>  --json
PR refs: a number (GitHub PR in this repository), a local branch name, or id:<n>.`;

/** The run was saved but PR/branch tracking failed; do not re-ingest, retry tracking instead. */
export const EXIT_SAVED_TRACKING_FAILED = 3;
/** The server could not be reached: the upload is in the local outbox; deliver it with `benchboard push`. */
export const EXIT_QUEUED = 4;

const json = (value: unknown) => process.stdout.write(JSON.stringify(value, null, 2) + "\n");
const clean = (value: string) => stripVTControlCharacters(value).replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
const color = (format: Parameters<typeof styleText>[0], text: string) => process.stdout.isTTY ? styleText(format, text) : text;

export function duration(seconds: number): string {
	const [scale, unit] = seconds < 1e-3 ? [1e6, "µs"] : seconds < 1 ? [1e3, "ms"] : [1, "s"];
	return `${(seconds * scale).toFixed(seconds * scale >= 100 ? 1 : 3)} ${unit}`;
}
const percent = (ratio: number) => `${ratio >= 1 ? "+" : ""}${((ratio - 1) * 100).toFixed(2)}%`;

function open(url: string) {
	const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
	spawn(command, [url], { stdio: "ignore", detached: true }).unref();
}

function readMetadata(source: string | undefined): unknown {
	if (!source) return {};
	const text = source === "-" ? fs.readFileSync(0, "utf8") : fs.readFileSync(source, "utf8");
	try {
		return JSON.parse(text);
	} catch (error) {
		throw new Error(`Metadata is not valid JSON: ${(error as Error).message}`);
	}
}

const prName = (pr: PullRequest) => pr.source === "github" ? `${pr.githubRepo}#${pr.number}` : `branch ${pr.headRef}`;

function verdictText(comparison: Comparison | null): string {
	if (!comparison) return color("dim", "—");
	const interval = comparison.low === null || comparison.high === null ? "no interval" : `[${percent(comparison.low)}, ${percent(comparison.high)}]`;
	const text = `${percent(comparison.ratio)} ${interval}`;
	const styles = { regression: "red", improvement: "green", unchanged: "dim", inconclusive: "yellow", failed: "magenta", insufficient: "yellow" } as const;
	const verdict = comparison.verdict === "insufficient" ? `insufficient data (n=${Math.min(comparison.candidate.n, comparison.baseline.n)})` : comparison.verdict;
	return color(styles[comparison.verdict], `${text} ${verdict}${comparison.sameRun ? "" : " (cross-invocation)"}`);
}

function printReport({ report, machines, benchmarks, commits }: ReportBundle) {
	const pr = report.pullRequest;
	const machine = machines.find((entry) => entry.id === report.machineId);
	const benchmark = new Map(benchmarks.map((entry) => [entry.id, entry]));
	const commit = new Map(commits.map((entry) => [entry.sha, entry]));
	console.log(color("bold", `${prName(pr)}: ${clean(pr.title)}`));
	console.log(`${pr.baseRef}@${pr.baseSha?.slice(0, 10) ?? "?"} → ${pr.headRef}@${pr.headSha.slice(0, 10)} · ${report.commits.length - (pr.baseSha ? 1 : 0)} commits`);
	console.log(`Statistic ${report.statistic}, threshold ±${(report.threshold * 100).toFixed(1)}%, 95% bootstrap CI` +
		(machine ? `, machine ${machine.id} (${machine.hostname}, ${machine.cpu})` : "") +
		(report.machines.length > 1 ? ` — ${report.machines.length} machines recorded; pass --machine to switch` : ""));
	const s = report.summary;
	console.log(`${s.series} series: ${color("red", `${s.regression} regressions`)}, ${color("green", `${s.improvement} improvements`)}, ` +
		`${s.unchanged} unchanged, ${color("yellow", `${s.inconclusive} inconclusive`)}, ${s.failed} failed` +
		(s.insufficient ? `, ${s.insufficient} with too few samples` : "") +
		(s.missingHead ? `; ${s.missingHead} not measured at the head` : "") +
		(s.missingReference ? `; ${s.missingReference} without a base measurement` : ""));
	if (!report.series.length) {
		console.log("\nNo measurements on this PR's commits yet. Ingest Hyperfine exports with --commit set to PR commits or the base.");
		return;
	}
	for (const series of report.series) {
		const key = benchmark.get(series.benchmarkId)?.key ?? `benchmark ${series.benchmarkId}`;
		console.log("\n" + color("bold", `${key}${series.caseKey === "default" ? "" : ` / ${series.caseKey}`}`) +
			color("dim", `  ${clean(series.label).slice(0, 80)}`));
		const versus = series.referenceIsBase ? "base" : "first measured commit";
		if (series.head) console.log(`  head vs ${versus}: ${verdictText(series.headComparison)}`);
		else console.log(`  head not measured; latest measured #${series.latest?.position} vs ${versus}: ${verdictText(series.latestComparison)}`);
		for (const point of series.points) {
			const label = `${point.isBase ? "base" : String(point.position).padStart(4)} ${point.sha.slice(0, 10)}`;
			const subject = clean(commit.get(point.sha)?.subject ?? "").slice(0, 48).padEnd(48);
			const m: Measurement | null = point.measurement;
			if (!m) { console.log(color("dim", `  ${label} ${subject} not measured`)); continue; }
			const value = report.statistic === "mean" ? m.mean : m.median;
			const extra = point.candidates.length > 1 ? color("dim", ` (+${point.candidates.length - 1} more)`) : "";
			console.log(`  ${label} ${subject} ${duration(value).padStart(11)} n=${String(m.n).padEnd(4)}${m.dirty ? " dirty" : ""}` +
				`  Δprev ${verdictText(point.vsPrevious)}${point.spansGap ? color("dim", ` (since #${point.previousPosition})`) : ""}${extra}`);
		}
	}
}

function printRun({ run, repository, machine, measurements, comparisons }: RunDetail, statistic: "median" | "mean", webUrl: string) {
	const shas = new Set(measurements.map((m) => m.commitSha));
	console.log(run.title ? color("bold", clean(run.title)) + color("dim", `  ${run.id}`) : color("bold", `Run ${run.id}`));
	console.log(`${repository.slug} · ${measurements.length} cases · ${shas.size} commit${shas.size === 1 ? "" : "s"} · ${run.recordedAt.replace("T", " ").slice(0, 16)} UTC` +
		` · ${machine.hostname}${machine.platform ? ` (${machine.platform})` : ""}${run.warmup !== null ? ` · warmup ${run.warmup}` : ""}`);
	if (run.conditions) console.log(color("dim", clean(run.conditions)));
	const byCandidate = new Map(comparisons.map((comparison) => [comparison.candidate.id, comparison]));
	const width = Math.min(40, Math.max(6, ...measurements.map((m) => `${m.benchmarkKey}/${m.caseKey}`.length)));
	console.log(color("dim", `\n  ${"#".padStart(3)} ${"series".padEnd(width)} ${"commit".padEnd(10)} ${statistic.padStart(11)} ${"n".padStart(5)}  change vs first case`));
	for (const m of measurements) {
		const comparison = byCandidate.get(m.id);
		const versus = comparison ? `${verdictText(comparison)} ${color("dim", `vs #${comparison.baseline.position}`)}` : "";
		const flags = `${m.dirty ? " dirty" : ""}${m.status === "failed" ? color("magenta", " failed") : ""}${m.profileCount ? color("dim", ` ${m.profileCount} profile${m.profileCount > 1 ? "s" : ""}`) : ""}`;
		console.log(`  ${String(m.position).padStart(3)} ${`${m.benchmarkKey}/${m.caseKey}`.slice(0, width).padEnd(width)} ${(m.commitSha?.slice(0, 10) ?? "—").padEnd(10)} ` +
			`${duration(statistic === "mean" ? m.mean : m.median).padStart(11)} ${String(m.n).padStart(5)}  ${versus}${flags}`);
	}
	console.log(color("dim", `\n${webUrl}/runs/${run.id}`));
}

async function reachable(port: number): Promise<boolean> {
	try {
		const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1000) });
		return response.ok;
	} catch {
		return false;
	}
}

/** Starts a detached `serve` for the same data directory unless one already answers on the port. */
async function ensureServer(home: string, port: number, explicitHome: string | undefined) {
	if (await reachable(port)) return;
	fs.mkdirSync(home, { recursive: true, mode: 0o700 });
	const log = fs.openSync(path.join(home, "serve.log"), "a");
	// A standalone binary is its own entry point; from source, re-run the script with bun.
	const self = Bun.main.startsWith("/$bunfs/") ? [] : [process.argv[1]];
	const args = [...self, "serve", "--port", String(port), ...(explicitHome ? ["--home", explicitHome] : [])];
	spawn(process.execPath, args, { detached: true, stdio: ["ignore", log, log], env: { ...process.env, BENCHBOARD_HOME: home } }).unref();
	for (let attempt = 0; attempt < 50; attempt++) {
		await new Promise((resolve) => setTimeout(resolve, 100));
		if (await reachable(port)) {
			console.error(`Started benchboard server on port ${port} (log: ${path.join(home, "serve.log")}).`);
			return;
		}
	}
	throw new Error(`The server did not start; see ${path.join(home, "serve.log")}.`);
}

async function serve(store: Store, flags: { host?: string; port?: string; auth?: string; publicUrl?: string }, openBrowser: boolean): Promise<number> {
	const options = serverOptionsFromEnv(flags);
	const server = createServer(store, options);
	const local = `http://${options.host.includes(":") ? `[${options.host}]` : options.host === "127.0.0.1" || options.host === "0.0.0.0" ? "localhost" : options.host}:${server.port}`;
	const url = options.publicUrl ?? local;
	console.error(`benchboard serving ${url} (GraphQL at ${url}/graphql; listening on ${options.host}:${server.port}, auth ${options.auth}), data in ${store.home}`);
	if (openBrowser) open(url);
	await new Promise<void>((resolve) => {
		const stop = () => {
			console.error("benchboard: shutting down");
			void server.stop().then(() => resolve());
		};
		process.once("SIGINT", stop);
		process.once("SIGTERM", stop);
	});
	store.db.run("PRAGMA optimize");
	return 0;
}

/** Reads a secret from stdin: without echo on a terminal, else the first line of piped input. */
async function readSecret(prompt: string): Promise<string> {
	if (!process.stdin.isTTY) return fs.readFileSync(0, "utf8").split("\n", 1)[0].trim();
	process.stderr.write(prompt);
	process.stdin.setRawMode(true);
	process.stdin.resume();
	let value = "";
	try {
		for await (const chunk of process.stdin) {
			for (const char of String(chunk)) {
				if (char === "\r" || char === "\n") return value.trim();
				if (char === "\u0003") throw new Error("Cancelled.");
				if (char === "\u007f") value = value.slice(0, -1);
				else value += char;
			}
		}
		return value.trim();
	} finally {
		process.stdin.setRawMode(false);
		process.stdin.pause();
		process.stderr.write("\n");
	}
}

/** Snapshots a GitHub PR, looking up the repository through the checkout's remotes when not given. */
function githubSnapshot(cwd: string, reference: string | number, knownRepo?: string | null): Promise<PullRequestSnapshot> {
	const parsed = parsePullRequestReference(String(reference));
	const identity = repositoryIdentity(cwd);
	const checkout = identity.root;
	return snapshotGithubPullRequest({
		number: parsed.number,
		candidates: parsed.githubRepo ? [parsed.githubRepo] : [...new Set([...(checkout ? githubRemotes(checkout) : []), ...(knownRepo ? [knownRepo] : [])])],
		repository: checkout ? identity : null,
		resolveLocal: checkout ? (sha) => resolveCommit(checkout, sha) : undefined,
	});
}

const slugOf = (cwd: string) => repositoryIdentity(cwd).slug;

/** "90s", "30m", "6h", "1d" or plain seconds, in milliseconds. */
export function parseInterval(value: string): number {
	const match = /^(\d+(?:\.\d+)?)\s*(s|m|h|d)?$/.exec(value.trim());
	if (!match) throw new Error(`Invalid interval "${value}"; use e.g. 30m, 6h or 1d.`);
	const ms = Number(match[1]) * { s: 1e3, m: 6e4, h: 36e5, d: 864e5 }[match[2] as "s" | "m" | "h" | "d" ?? "s"];
	if (ms < 1000) throw new Error("The interval must be at least one second.");
	return ms;
}

/**
 * How to track a GitHub PR: snapshot it here (this machine's GitHub access), or, when that fails and a
 * server is in use, let the server fetch it with its own credentials (runners need no GitHub token).
 */
async function githubTracking(api: Backend, cwd: string, reference: string | number): Promise<Operation> {
	try {
		return { method: "savePullRequest", args: [await githubSnapshot(cwd, reference)] };
	} catch (error) {
		if (api instanceof LocalBackend) throw error;
		const identity = repositoryIdentity(cwd);
		const parsed = parsePullRequestReference(String(reference));
		return {
			method: "syncGithubPullRequest",
			args: [identity.root ? identity : null, String(reference), parsed.githubRepo ? [] : identity.root ? githubRemotes(identity.root) : []],
		};
	}
}

const transient = (error: unknown) => error instanceof HttpError && error.transient;

export async function main(argv: string[]): Promise<number> {
	const { values: options, positionals } = parseArgs({
		args: argv, allowPositionals: true, strict: true,
		options: {
			help: { type: "boolean", short: "h" }, version: { type: "boolean", short: "V" }, json: { type: "boolean" }, cwd: { type: "string" }, home: { type: "string" },
			server: { type: "string" }, local: { type: "boolean" }, token: { type: "string" }, scope: { type: "string" },
			meta: { type: "string" }, benchmark: { type: "string" }, title: { type: "string" }, commit: { type: "string" },
			dirty: { type: "boolean" }, clean: { type: "boolean" }, pr: { type: "string" }, "track-branch": { type: "boolean" },
			"allow-duplicate": { type: "boolean" }, branch: { type: "boolean" }, base: { type: "string" },
			all: { type: "boolean" }, statistic: { type: "string" }, threshold: { type: "string" }, machine: { type: "string" },
			"include-dirty": { type: "boolean" }, limit: { type: "string" }, variables: { type: "string" },
			port: { type: "string" }, host: { type: "string" }, open: { type: "boolean" }, auth: { type: "string" }, "public-url": { type: "string" },
			syms: { type: "string" }, iterations: { type: "string" }, label: { type: "string" }, rate: { type: "string" },
			metric: { type: "string" }, "measured-on": { type: "string" }, every: { type: "string" }, verify: { type: "boolean" },
			force: { type: "boolean" },
		},
	});
	const [command, ...rest] = positionals;
	if (options.version || command === "version") { console.log(`benchboard ${VERSION}`); return 0; }
	if (options.help || !command || command === "help") { console.log(HELP); return command || options.help ? 0 : 1; }
	if (command === "schema") { process.stdout.write(typeDefs); return 0; }
	const cwd = path.resolve(options.cwd ?? process.cwd());
	const home = options.home ? path.resolve(options.home) : undefined;

	let store: Store | undefined;
	const openStore = () => store ??= new Store(home);
	/** Commands that manage a data directory itself always work locally (run them on the server host). */
	const localOnly = () => {
		if (options.server) throw new Error(`\`benchboard ${command}\` works on a local data directory; run it on the server host.`);
		return openStore();
	};
	let backend: Backend | undefined;
	const getBackend = (): Backend => {
		if (backend) return backend;
		const target = resolveTarget({ server: options.server, local: options.local, home });
		if (target.kind === "remote") {
			const remote = new RemoteBackend(target.server, target.token);
			remote.onRetry = (attempt, delay, error) => console.error(`benchboard: ${error.message}; retry ${attempt} in ${(delay / 1000).toFixed(0)} s`);
			backend = remote;
		} else {
			backend = new LocalBackend(openStore(), { webUrl: `http://localhost:${options.port ?? DEFAULT_PORT}` });
		}
		return backend;
	};

	try {
		switch (command) {
			case "ingest": {
				if (rest.length !== 1) throw new Error("Usage: benchboard ingest <export.json> [options]");
				if (options.dirty && options.clean) throw new Error("Pass at most one of --dirty and --clean.");
				const metadata = readMetadata(options.meta) as Record<string, unknown>;
				const overrides = {
					benchmark: options.benchmark, title: options.title, commit: options.commit, pullRequest: options.pr,
					dirty: options.dirty ? true : options.clean ? false : undefined,
				};
				for (const [key, value] of Object.entries(overrides)) if (value !== undefined) metadata[key] = value;
				if (options["measured-on"]) metadata.machine = { ...(metadata.machine as object | undefined), hostname: options["measured-on"] };
				const pullRequest = metadata.pullRequest as string | number | undefined;
				// Reject malformed references before anything is saved.
				if (pullRequest !== undefined) parsePullRequestReference(String(pullRequest));
				const api = getBackend();
				const prepared = prepareRun({ file: rest[0], cwd, metadata });
				// Tracking is worked out before uploading, so a queued upload carries it too.
				const tracking: { what: string; operation: Operation }[] = [];
				const trackingErrors: string[] = [];
				const plan = async (what: string, operation: () => Promise<Operation> | Operation) => {
					try {
						tracking.push({ what, operation: await operation() });
					} catch (error) {
						trackingErrors.push(`${what}: ${(error as Error).message}`);
					}
				};
				if (pullRequest !== undefined) await plan(`pull request ${pullRequest}`, () => githubTracking(api, cwd, pullRequest));
				if (options["track-branch"]) await plan("branch", () => ({ method: "savePullRequest", args: [snapshotLocalBranch({ cwd, base: options.base })] }));
				let result: Awaited<ReturnType<Backend["ingest"]>>;
				try {
					result = await api.ingest(prepared, { allowDuplicate: options["allow-duplicate"] });
				} catch (error) {
					if (!transient(error)) throw error;
					const operations: Operation[] = [{ method: "ingest", args: [prepared, { allowDuplicate: options["allow-duplicate"] }] }, ...tracking.map((entry) => entry.operation)];
					const directory = enqueue(api.webUrl, `run ${rest[0]} (${operations.length} operation${operations.length > 1 ? "s" : ""})`, operations, (error as Error).message);
					if (options.json) json({ queued: directory, error: (error as Error).message, trackingErrors });
					console.error(`benchboard: ${(error as Error).message}\nThe run is saved in ${directory}; upload it with \`benchboard push\` once the server is reachable.`);
					return EXIT_QUEUED;
				}
				// The run is durable from here on: tracking failures are reported alongside it, never instead of it.
				const tracked: PullRequest[] = [];
				for (const { what, operation } of tracking) {
					try {
						tracked.push(((await api.invoke(operation.method, operation.args)) as { pullRequest: PullRequest }).pullRequest);
					} catch (error) {
						trackingErrors.push(`${what}: ${(error as Error).message}`);
					}
				}
				if (options.json) {
					json({ ...result, pullRequests: tracked, trackingErrors, url: `${api.webUrl}/runs/${result.run.id}` });
				} else {
					console.log(`Saved run ${result.run.id} → ${result.repository.slug} / ${result.benchmark.key}`);
					for (const m of result.measurements) {
						console.log(`  ${m.position}. [${m.caseKey}] ${clean(m.label).slice(0, 60)} @ ${m.commitSha?.slice(0, 10) ?? "no commit"}` +
							`${m.dirty ? " (dirty)" : ""}: ${m.status}, n=${m.n}, median ${duration(m.median)}, mean ${duration(m.mean)}`);
					}
					for (const warning of result.warnings) console.log(color("yellow", `warning: ${warning}`));
					for (const pr of tracked) console.log(`Tracking ${prName(pr)} (id ${pr.id}): benchboard pr report id:${pr.id}`);
					console.log(color("dim", `${api.webUrl}/runs/${result.run.id}`));
				}
				if (trackingErrors.length) {
					for (const error of trackingErrors) console.error(`benchboard: run ${result.run.id} was saved, but tracking failed (${error}).`);
					console.error(pullRequest !== undefined ? `Retry with: benchboard pr track ${pullRequest}` : "Retry with: benchboard pr track --branch");
					return EXIT_SAVED_TRACKING_FAILED;
				}
				return 0;
			}
			case "pr": {
				const [action, reference] = rest;
				const api = getBackend();
				const report = (tracked: { pullRequest: PullRequest; commitCount: number }, verb: string) => {
					const pr = tracked.pullRequest;
					if (options.json) json(pr);
					else console.log(`${verb} ${prName(pr)} (id ${pr.id}) with ${tracked.commitCount} commits on base ${pr.baseSha?.slice(0, 10)}.`);
				};
				if (action === "track") {
					if (!options.branch && !reference) throw new Error("Usage: benchboard pr track <ref> | --branch [name] [--base ref]");
					const operation: Operation = options.branch
						? { method: "savePullRequest", args: [snapshotLocalBranch({ cwd, head: reference, base: options.base })] }
						: await githubTracking(api, cwd, reference);
					report(await api.invoke(operation.method, operation.args) as { pullRequest: PullRequest; commitCount: number }, "Tracking");
					return 0;
				}
				if (action === "sync") {
					if (!reference) throw new Error("Usage: benchboard pr sync <ref>");
					const pr = await api.resolvePullRequest(slugOf(cwd), reference);
					const repository = await api.repository(pr.repositoryId);
					let snapshot: PullRequestSnapshot;
					if (pr.source === "github") {
						try {
							snapshot = await githubSnapshot(cwd, `${pr.githubRepo}#${pr.number}`);
						} catch (error) {
							if (api instanceof LocalBackend) throw error;
							// No GitHub access here: the server syncs it with its own.
							const tracked = await api.syncGithubPullRequest(null, `${pr.githubRepo}#${pr.number}`, []);
							if (options.json) json(tracked.pullRequest);
							else console.log(`Synced ${prName(tracked.pullRequest)} on the server: ${tracked.commitCount} commits, head ${tracked.pullRequest.headSha.slice(0, 10)}.`);
							return 0;
						}
						// Only attribute the PR to this checkout when it is a clone of the PR's repository.
						if (snapshot.repository && snapshot.repository.slug !== repository?.slug) snapshot = { ...snapshot, repository: null };
					} else {
						// Local branches come from a checkout: the recorded one when this is a local data directory, else cwd.
						const recorded = api instanceof LocalBackend && repository?.localPath && fs.existsSync(repository.localPath) ? repository.localPath : null;
						const checkout = recorded ?? cwd;
						if (slugOf(checkout) !== repository?.slug) throw new Error(`Run this in a checkout of ${repository?.slug ?? "the branch's repository"}.`);
						snapshot = snapshotLocalBranch({ cwd: checkout, head: pr.headRef, base: pr.baseRef, title: pr.title });
					}
					const tracked = await api.savePullRequest(snapshot);
					if (options.json) json(tracked.pullRequest);
					else console.log(`Synced ${prName(tracked.pullRequest)}: ${tracked.commitCount} commits, head ${tracked.pullRequest.headSha.slice(0, 10)}.`);
					return 0;
				}
				if (action === "list") {
					const prs = await api.pullRequests(options.all ? null : slugOf(cwd));
					if (options.json) json(prs);
					else for (const pr of prs) console.log(`id:${pr.id}\t${prName(pr)}\t${pr.state}\t${clean(pr.title)}`);
					return 0;
				}
				if (action === "report") {
					if (!reference) throw new Error("Usage: benchboard pr report <ref>");
					const statistic = options.statistic ?? "median";
					if (statistic !== "median" && statistic !== "mean") throw new Error("--statistic must be median or mean.");
					const threshold = options.threshold === undefined ? 0.02 : Number(options.threshold) / 100;
					if (!Number.isFinite(threshold) || threshold < 0) throw new Error("--threshold must be a nonnegative percentage.");
					const pr = await api.resolvePullRequest(slugOf(cwd), reference);
					const bundle = await api.pullRequestReport(pr.id, {
						statistic, threshold, includeDirty: options["include-dirty"],
						machineId: options.machine === undefined ? undefined : Number(options.machine),
					});
					if (options.json) json(bundle.report);
					else printReport(bundle);
					return 0;
				}
				throw new Error("Usage: benchboard pr <track|sync|list|report> ...");
			}
			case "profile": {
				const [action, ...args] = rest;
				const api = getBackend();
				const iterations = options.iterations === undefined ? undefined : Number(options.iterations);
				if (iterations !== undefined && (!Number.isSafeInteger(iterations) || iterations < 1)) throw new Error("--iterations must be a positive integer.");
				const printProfile = (profile: Profile, m: Measurement) => {
					console.log(`Profile ${profile.id} → run ${m.runId} case ${m.position} [${m.caseKey}] @ ${m.commitSha?.slice(0, 10) ?? "?"}: ` +
						`${profile.samples} samples, ${(profile.cpuMs / profile.iterations).toFixed(1)} ms on CPU` +
						(profile.waitsSampled === false ? ` per iteration (${profile.platform ?? "Linux"}: waits not sampled)`
							: ` and ${(profile.sampledMs / profile.iterations).toFixed(1)} ms sampled per iteration`) +
						`${profile.cpuSource === "sample-count" ? " (no CPU deltas: CPU estimated from samples)" : ""}, ` +
						`${(profile.symbolicatedShare * 100).toFixed(1)}% symbolicated${profile.symsSha256 ? "" : " (no .syms.json sidecar)"}`);
				};
				/** Uploads a profile, queueing it in the outbox if the server is unreachable. */
				const upload = async (measurement: Measurement, prepared: ReturnType<typeof prepareProfile>): Promise<number> => {
					let detail: Awaited<ReturnType<Backend["attachProfile"]>>;
					try {
						detail = await api.attachProfile(measurement.id, prepared);
					} catch (error) {
						if (!transient(error)) throw error;
						const directory = enqueue(api.webUrl, `profile for ${measurement.runId}:${measurement.position}`, [{ method: "attachProfile", args: [measurement.id, prepared] }], (error as Error).message);
						console.error(`benchboard: ${(error as Error).message}\nThe profile is saved in ${directory}; upload it with \`benchboard push\`.`);
						return EXIT_QUEUED;
					}
					if (options.json) json(detail.profile); else printProfile(detail.profile, detail.measurement);
					return 0;
				};
				if (action === "attach") {
					if (args.length !== 2) throw new Error("Usage: benchboard profile attach <run>[:<case>] <profile.json.gz>");
					const measurement = await api.measurement(args[0]);
					return upload(measurement, prepareProfile({ file: args[1], syms: options.syms, iterations, label: options.label, cwd }));
				}
				if (action === "check") {
					const checks = samplyChecks();
					if (options.json) json(checks);
					else for (const check of checks) {
						const mark = check.ok === true ? color("green", "ok  ") : check.ok === false ? color("red", "FAIL") : color("yellow", "note");
						console.log(`${mark} ${check.name}: ${check.detail}${check.fix ? color("dim", `\n     ${check.fix}`) : ""}`);
					}
					return checks.some((check) => check.ok === false) ? 1 : 0;
				}
				if (action === "record") {
					if (!args.length) throw new Error("Usage: benchboard profile record <run>[:<case>] [-- command...]");
					// Fail before running the workload when samply cannot record here at all.
					const problem = samplyProblem();
					if (problem) throw new Error(`cannot profile on this machine: ${problem}`);
					const measurement = await api.measurement(args[0]);
					const command = args.length > 1 ? args.slice(1) : ["sh", "-c", measurement.command ?? measurement.exportedCommand];
					const directory = fs.mkdtempSync(path.join(os.tmpdir(), "benchboard-samply-"));
					try {
						const output = path.join(directory, "profile.json.gz");
						const samply = Bun.spawnSync(["samply", "record", "--save-only", "--no-open", "--unstable-presymbolicate", "-o", output,
							...(options.rate ? ["--rate", options.rate] : []), ...(iterations ? ["--iteration-count", String(iterations)] : []), ...command],
						{ cwd, stdout: "inherit", stderr: "inherit" });
						if (samply.exitCode !== 0) throw new Error(samplyFailureHint(samply.exitCode));
						return await upload(measurement, prepareProfile({ file: output, iterations, label: options.label, command: command.join(" "), cwd }));
					} finally {
						fs.rmSync(directory, { recursive: true, force: true });
					}
				}
				const limit = Number(options.limit ?? 25);
				if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("--limit must be a positive integer.");
				const profileId = (value: string | undefined) => {
					if (!value || !/^\d+$/.test(value)) throw new Error(`Unknown profile ${value ?? ""}.`);
					return Number(value);
				};
				const ms = (value: number) => `${value.toFixed(1)} ms`.padStart(11);
				const metric = options.metric === "sampled" ? "sampled" : "cpu";
				if (options.metric !== undefined && options.metric !== "cpu" && options.metric !== "sampled") throw new Error("--metric must be cpu or sampled.");
				const metricLabel = metric === "cpu" ? "on-CPU" : "sampled (incl. off-CPU)";
				if (action === "show") {
					const id = profileId(args[0]);
					const [{ profile, measurement }, stats] = await Promise.all([api.profile(id), api.profileFunctions(id, metric, limit)]);
					if (options.json) { json(stats); return 0; }
					printProfile(profile, measurement);
					if (metric === "sampled" && profile.waitsSampled === false) {
						console.log(color("yellow", `note: recorded on ${profile.platform ?? "Linux"}, where samply samples running threads only; sampled time is on-CPU time.`));
					}
					console.log(`${"self".padStart(11)} ${"total".padStart(11)}  function · ${metricLabel} ms per iteration`);
					for (const stat of stats) console.log(`${ms(stat.self)} ${ms(stat.total)}  ${clean(stat.name).slice(0, 120)}${stat.library ? color("dim", `  ${stat.library}`) : ""}`);
					return 0;
				}
				if (action === "diff") {
					const [baseId, headId] = [profileId(args[0]), profileId(args[1])];
					const [{ profile: base }, { profile: head }, deltas] = await Promise.all([
						api.profile(baseId), api.profile(headId), api.profileDiff(baseId, headId, metric, limit),
					]);
					if (options.json) { json(deltas); return 0; }
					const total = (p: Profile) => (metric === "cpu" ? p.cpuMs : p.sampledMs) / p.iterations;
					console.log(`${metric === "cpu" ? "On-CPU" : "Sampled"} time per iteration: ${total(base).toFixed(1)} ms → ${total(head).toFixed(1)} ms (${percent(total(head) / total(base))})`);
					console.log(`${"Δ self".padStart(11)} ${"base".padStart(11)} ${"head".padStart(11)}  function`);
					for (const d of deltas) {
						const delta = d.headSelfMs - d.baseSelfMs;
						console.log(`${color(delta > 0 ? "red" : "green", ms(delta))} ${ms(d.baseSelfMs)} ${ms(d.headSelfMs)}  ${clean(d.name).slice(0, 110)}`);
					}
					return 0;
				}
				throw new Error("Usage: benchboard profile <attach|record|show|diff> ...");
			}
			case "run": {
				const [action, reference] = rest;
				if (action !== "show" || !reference) throw new Error("Usage: benchboard run show <run-id|latest>");
				const statistic = options.statistic ?? "median";
				if (statistic !== "median" && statistic !== "mean") throw new Error("--statistic must be median or mean.");
				const threshold = options.threshold === undefined ? 0.02 : Number(options.threshold) / 100;
				const api = getBackend();
				const detail = await api.runDetail(reference === "latest" && !options.all ? slugOf(cwd) : null, reference, { statistic, threshold });
				if (options.json) { json(detail); return 0; }
				printRun(detail, statistic, api.webUrl);
				return 0;
			}
			case "push": {
				const entries = pending();
				if (!entries.length) { console.log("Nothing to push."); return 0; }
				let failures = 0;
				for (const entry of entries) {
					const target = resolveTarget({ server: entry.server });
					const remote = new RemoteBackend(entry.server, target.kind === "remote" ? target.token : null);
					remote.onRetry = (attempt, delay) => console.error(`  ${entry.server} unavailable; retry ${attempt} in ${(delay / 1000).toFixed(0)} s`);
					try {
						for (const operation of entry.operations) await remote.invoke(operation.method, operation.args);
						remove(entry.id);
						console.log(`Pushed ${entry.label} to ${entry.server}.`);
					} catch (error) {
						failures++;
						recordError(entry.id, (error as Error).message);
						console.error(`benchboard: ${entry.label}: ${(error as Error).message}${transient(error) ? " (kept; push again later)" : ` (kept in ${outboxDir()}/${entry.id}; it will not succeed as is)`}`);
					}
				}
				return failures ? 1 : 0;
			}
			case "runs": {
				const runs = await getBackend().runs(options.all ? null : slugOf(cwd), options.limit ? Number(options.limit) : 20);
				if (options.json) json(runs);
				else for (const run of runs) console.log(`${run.id}\t${run.recordedAt}\t${clean(run.title ?? "(untitled)")}`);
				return 0;
			}
			case "query": {
				if (rest.length !== 1) throw new Error("Usage: benchboard query <graphql|@file> [--variables json]");
				const source = rest[0].startsWith("@") ? fs.readFileSync(rest[0].slice(1), "utf8") : rest[0];
				const variables = options.variables ? JSON.parse(options.variables) : undefined;
				const result = await getBackend().query(source, variables);
				json(result);
				return result.errors?.length ? 1 : 0;
			}
			case "open": {
				const api = getBackend();
				if (api instanceof LocalBackend) await ensureServer(api.store.home, Number(options.port ?? DEFAULT_PORT), options.home);
				let route = "/";
				if (rest[0] === "pr" && rest[1]) route = `/pr/${(await api.resolvePullRequest(slugOf(cwd), rest[1])).id}`;
				else if (rest[0] === "run" && rest[1]) route = `/runs/${rest[1]}`;
				else {
					const repository = await api.repositoryBySlug(slugOf(cwd));
					if (repository) route = `/repositories/${repository.id}`;
				}
				const url = `${api.webUrl}${route}`;
				console.log(url);
				open(url);
				return 0;
			}
			case "import-legacy": {
				const api = getBackend();
				const directory = path.resolve(rest[0] ?? path.join(os.homedir(), ".pi", "agent", "benchmarks"));
				const result = await importLegacy({ known: new Set(await api.legacyIds()), ingest: (run) => api.ingest(run, { allowDuplicate: true }) }, directory);
				if (options.json) json(result);
				else {
					console.log(`Imported ${result.imported}, already present ${result.skipped}, failed ${result.failed.length}.`);
					for (const failure of result.failed) console.log(`  ${failure.id}: ${failure.error}`);
				}
				return result.failed.length ? 1 : 0;
			}
			case "login": {
				if (rest.length !== 1) throw new Error("Usage: benchboard login <server-url> [--token <token>]");
				const token = options.token ?? process.env.BENCHBOARD_TOKEN ?? await readSecret(`API token for ${rest[0]}: `);
				if (!token) throw new Error("No token given.");
				const remote = new RemoteBackend(rest[0], token);
				const identity = await remote.whoami();
				saveLogin({ server: remote.webUrl, token });
				console.log(`Signed in to ${remote.webUrl} as ${identity.principal.name} (${identity.principal.scope}); saved in ${configFile()}.`);
				return 0;
			}
			case "logout": {
				const saved = readLogin();
				console.log(removeLogin() ? `Forgot the login for ${saved?.server}.` : "Not signed in.");
				return 0;
			}
			case "whoami": {
				const api = getBackend();
				const identity = await api.whoami();
				const where = api instanceof LocalBackend ? `local data directory ${api.store.home}` : api.webUrl;
				if (options.json) json({ target: where, ...identity });
				else console.log(`${where}: ${identity.principal.name} (${identity.principal.scope}), benchboard ${identity.version}, schema ${identity.schemaVersion}`);
				const queued = pending().length;
				if (queued && !options.json) console.log(color("yellow", `${queued} upload${queued > 1 ? "s" : ""} waiting in ${outboxDir()}; run \`benchboard push\`.`));
				return 0;
			}
			case "serve":
				return await serve(localOnly(), { host: options.host, port: options.port, auth: options.auth, publicUrl: options["public-url"] }, options.open ?? false);
			case "token": {
				const [action, argument] = rest;
				const local = localOnly();
				if (action === "create") {
					if (!argument) throw new Error("Usage: benchboard token create <name> [--scope read|write|admin]");
					const { token, record } = createToken(local, argument, parseScope(options.scope ?? "write"));
					if (options.json) json({ token, ...record });
					else {
						console.error(`Created ${record.scope} token "${record.name}" (id ${record.id}). It is shown only once:`);
						console.log(token);
					}
					return 0;
				}
				if (action === "list") {
					const tokens = listTokens(local, { includeRevoked: options.all });
					if (options.json) json(tokens);
					else for (const entry of tokens) {
						console.log(`${entry.id}\t${entry.name}\t${entry.scope}\t${entry.prefix}…\tcreated ${entry.createdAt}\tlast used ${entry.lastUsedAt ?? "never"}${entry.revokedAt ? `\trevoked ${entry.revokedAt}` : ""}`);
					}
					return 0;
				}
				if (action === "revoke") {
					if (!argument) throw new Error("Usage: benchboard token revoke <id|name>");
					if (!revokeToken(local, argument)) throw new Error(`No active token ${argument}.`);
					console.log(`Revoked ${argument}.`);
					return 0;
				}
				throw new Error("Usage: benchboard token <create|list|revoke> ...");
			}
			case "backup": {
				if (rest.length !== 1) throw new Error("Usage: benchboard backup <directory> [--every <interval>] [--verify]");
				const local = localOnly();
				const once = () => {
					const result = backup(local, rest[0]);
					if (options.json) json(result);
					else console.log(`${new Date().toISOString()} backed up ${local.home} to ${result.directory}: database plus ${result.copied} new files (${result.skipped} already present), ${(result.bytes / 1024 / 1024).toFixed(1)} MiB written.`);
					if (options.verify) {
						const copy = new Store(result.directory);
						try {
							const check = verify(copy);
							if (!check.ok) throw new Error(`the backup in ${result.directory} failed verification: ${JSON.stringify({ integrity: check.integrity, missingExports: check.missingExports.length, missingProfiles: check.missingProfiles.length })}`);
							if (!options.json) console.log(`${new Date().toISOString()} verified: ${check.counts.runs} runs, ${check.counts.profiles} profiles.`);
						} finally {
							copy.close();
						}
					}
				};
				if (!options.every) { once(); return 0; }
				// A backup service: back up now and then at every interval, until stopped (SIGTERM/SIGINT).
				const interval = parseInterval(options.every);
				let stop: () => void = () => {};
				const stopped = new Promise<void>((resolve) => { stop = resolve; });
				let running = true;
				for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => { running = false; stop(); });
				while (running) {
					try {
						once();
					} catch (error) {
						console.error(`${new Date().toISOString()} benchboard: backup failed: ${(error as Error).message}`);
					}
					await Promise.race([Bun.sleep(interval), stopped]);
				}
				return 0;
			}
			case "restore": {
				if (rest.length !== 1) throw new Error("Usage: benchboard restore <backup-directory> [--force]");
				const target = home ?? defaultHome();
				const result = restore(rest[0], target, { force: options.force });
				// Opening applies any newer migrations; then check what was restored.
				const restored = openStore();
				const check = verify(restored);
				console.log(`Restored ${path.resolve(rest[0])} into ${result.directory} (${result.files} files)${result.previous ? `; the previous database is ${result.previous}` : ""}.`);
				console.log(`${check.ok ? "Verified" : "VERIFICATION FAILED"}: ${check.counts.runs} runs, ${check.counts.profiles} profiles, ${check.counts.pullRequests} pull requests.`);
				return check.ok ? 0 : 1;
			}
			case "verify": {
				const result = verify(localOnly());
				if (options.json) json(result);
				else {
					console.log(`${result.ok ? "OK" : "PROBLEMS FOUND"}: schema ${result.schemaVersion}, ${result.counts.runs} runs, ${result.counts.measurements} measurements, ` +
						`${result.counts.profiles} profiles, ${result.counts.pullRequests} pull requests.`);
					if (result.integrity.join() !== "ok") console.log(`integrity_check: ${result.integrity.join("; ")}`);
					if (result.foreignKeyViolations) console.log(`${result.foreignKeyViolations} foreign key violations`);
					for (const file of result.missingExports) console.log(`missing export ${file}`);
					for (const file of result.missingProfiles) console.log(`missing profile file ${file}`);
				}
				return result.ok ? 0 : 1;
			}
			case "healthcheck": {
				const port = Number(options.port ?? process.env.BENCHBOARD_PORT ?? DEFAULT_PORT);
				const ok = await reachable(port);
				if (!ok) console.error(`benchboard: no healthy server on port ${port}.`);
				return ok ? 0 : 1;
			}
			default:
				throw new Error(`Unknown command "${command}". Run benchboard --help.`);
		}
	} catch (error) {
		console.error(`benchboard: ${(error as Error).message}`);
		return 1;
	} finally {
		store?.close();
	}
}
