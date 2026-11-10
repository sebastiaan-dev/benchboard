import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { parseArgs, stripVTControlCharacters, styleText } from "node:util";
import { spawn } from "node:child_process";
import { graphql } from "graphql";
import {
	Store, diffFunctions, parsePullRequestReference, functionStats, importLegacy, pullRequestReport, type Profile, type PullRequest, type PullRequestReport, type Measurement, type Comparison,
	type Repository,
} from "@benchboard/core";
import { createSchema, typeDefs } from "@benchboard/graphql";
import { createServer, DEFAULT_PORT } from "./server.ts";
import { profileRoutes } from "./profile-routes.ts";

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
  benchboard runs [--limit n] [--all]         Recent runs
  benchboard query <graphql|@file> [--variables <json>]
                                              Execute a GraphQL document locally; prints JSON
  benchboard schema                           Print the GraphQL schema
  benchboard serve [--port ${DEFAULT_PORT}] [--host 127.0.0.1] [--open]
  benchboard open [pr <ref> | run <id>] [--port ${DEFAULT_PORT}]
                                              Open the dashboard, starting a background server if needed
  benchboard import-legacy [dir]              Import pi /bench runs (~/.pi/agent/benchmarks)

Common options: --cwd <dir>  --json  --home <dir> (or BENCHBOARD_HOME)
PR refs: a number (GitHub PR in this repository), a local branch name, or id:<n>.`;

/** The run was saved but PR/branch tracking failed; do not re-ingest, retry tracking instead. */
export const EXIT_SAVED_TRACKING_FAILED = 3;

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

function currentRepository(store: Store, cwd: string): Repository {
	const repository = store.repositoryForCheckout(cwd);
	if (!repository) throw new Error(`No benchmarks or pull requests recorded for the repository at ${cwd}.`);
	return repository;
}

function resolvePullRequest(store: Store, cwd: string, reference: string): PullRequest {
	const internal = /^id:(\d+)$/.exec(reference);
	if (internal) {
		const pr = store.pullRequest(Number(internal[1]));
		if (!pr) throw new Error(`No tracked pull request with id ${internal[1]}.`);
		return pr;
	}
	const url = /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(reference) ?? /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(reference);
	if (url) {
		const pr = store.pullRequests().find((entry) => entry.githubRepo === url[1] && entry.number === Number(url[2]));
		if (!pr) throw new Error(`${reference} is not tracked; run \`benchboard pr track ${reference}\`.`);
		return pr;
	}
	const pr = store.findPullRequest(currentRepository(store, cwd).id, reference.replace(/^#/, ""));
	if (!pr) throw new Error(`No tracked pull request "${reference}" in this repository; run \`benchboard pr track\` first.`);
	return pr;
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

function printReport(store: Store, report: PullRequestReport) {
	const pr = report.pullRequest;
	const machine = report.machineId === null ? undefined : store.machine(report.machineId);
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
		const benchmark = store.benchmark(series.benchmarkId)!;
		console.log("\n" + color("bold", `${benchmark.key}${series.caseKey === "default" ? "" : ` / ${series.caseKey}`}`) +
			color("dim", `  ${clean(series.label).slice(0, 80)}`));
		const versus = series.referenceIsBase ? "base" : "first measured commit";
		if (series.head) console.log(`  head vs ${versus}: ${verdictText(series.headComparison)}`);
		else console.log(`  head not measured; latest measured #${series.latest?.position} vs ${versus}: ${verdictText(series.latestComparison)}`);
		for (const point of series.points) {
			const commit = store.commit(pr.repositoryId, point.sha);
			const label = `${point.isBase ? "base" : String(point.position).padStart(4)} ${point.sha.slice(0, 10)}`;
			const subject = clean(commit?.subject ?? "").slice(0, 48).padEnd(48);
			const m: Measurement | null = point.measurement;
			if (!m) { console.log(color("dim", `  ${label} ${subject} not measured`)); continue; }
			const value = report.statistic === "mean" ? m.mean : m.median;
			const extra = point.candidates.length > 1 ? color("dim", ` (+${point.candidates.length - 1} more)`) : "";
			console.log(`  ${label} ${subject} ${duration(value).padStart(11)} n=${String(m.n).padEnd(4)}${m.dirty ? " dirty" : ""}` +
				`  Δprev ${verdictText(point.vsPrevious)}${point.spansGap ? color("dim", ` (since #${point.previousPosition})`) : ""}${extra}`);
		}
	}
}

async function reachable(port: number): Promise<boolean> {
	try {
		const response = await fetch(`http://127.0.0.1:${port}/graphql?query=%7B__typename%7D`, { signal: AbortSignal.timeout(1000) });
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
	const args = [process.argv[1], "serve", "--port", String(port), ...(explicitHome ? ["--home", explicitHome] : [])];
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

async function serve(store: Store, host: string, port: number, openBrowser: boolean): Promise<number> {
	const server = createServer(store, { host, port, routes: [profileRoutes(store)] });
	const url = `http://${host.includes(":") ? `[${host}]` : host === "127.0.0.1" ? "localhost" : host}:${port}`;
	console.error(`benchboard serving ${url} (GraphQL at ${url}/graphql), data in ${store.home}`);
	if (openBrowser) open(url);
	await new Promise<void>((resolve) => {
		const stop = () => void server.stop().then(() => resolve());
		process.once("SIGINT", stop);
		process.once("SIGTERM", stop);
	});
	return 0;
}

export async function main(argv: string[]): Promise<number> {
	const { values: options, positionals } = parseArgs({
		args: argv, allowPositionals: true, strict: true,
		options: {
			help: { type: "boolean", short: "h" }, json: { type: "boolean" }, cwd: { type: "string" }, home: { type: "string" },
			meta: { type: "string" }, benchmark: { type: "string" }, title: { type: "string" }, commit: { type: "string" },
			dirty: { type: "boolean" }, clean: { type: "boolean" }, pr: { type: "string" }, "track-branch": { type: "boolean" },
			"allow-duplicate": { type: "boolean" }, branch: { type: "boolean" }, base: { type: "string" },
			all: { type: "boolean" }, statistic: { type: "string" }, threshold: { type: "string" }, machine: { type: "string" },
			"include-dirty": { type: "boolean" }, limit: { type: "string" }, variables: { type: "string" },
			port: { type: "string" }, host: { type: "string" }, open: { type: "boolean" },
			syms: { type: "string" }, iterations: { type: "string" }, label: { type: "string" }, rate: { type: "string" },
			metric: { type: "string" }, "measured-on": { type: "string" },
		},
	});
	const [command, ...rest] = positionals;
	if (options.help || !command || command === "help") { console.log(HELP); return command || options.help ? 0 : 1; }
	if (command === "schema") { process.stdout.write(typeDefs); return 0; }
	const cwd = path.resolve(options.cwd ?? process.cwd());
	const store = new Store(options.home ? path.resolve(options.home) : undefined);
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
				const result = store.ingest({ file: rest[0], cwd, metadata, allowDuplicate: options["allow-duplicate"] });
				// The run is durable from here on: tracking failures are reported alongside it, never instead of it.
				const tracked: PullRequest[] = [];
				const trackingErrors: string[] = [];
				const attempt = async (what: string, track: () => Promise<PullRequest> | PullRequest) => {
					try {
						tracked.push(await track());
					} catch (error) {
						trackingErrors.push(`${what}: ${(error as Error).message}`);
					}
				};
				if (pullRequest !== undefined) await attempt(`pull request ${pullRequest}`, () => store.syncGithubPullRequest({ cwd, reference: pullRequest }));
				if (options["track-branch"]) await attempt("branch", () => store.syncLocalBranch({ cwd, base: options.base }));
				if (options.json) {
					json({ ...result, pullRequests: tracked, trackingErrors, url: `http://localhost:${DEFAULT_PORT}/runs/${result.run.id}` });
				} else {
					console.log(`Saved run ${result.run.id} → ${result.repository.slug} / ${result.benchmark.key}`);
					for (const m of result.measurements) {
						console.log(`  ${m.position}. [${m.caseKey}] ${clean(m.label).slice(0, 60)} @ ${m.commitSha?.slice(0, 10) ?? "no commit"}` +
							`${m.dirty ? " (dirty)" : ""}: ${m.status}, n=${m.n}, median ${duration(m.median)}, mean ${duration(m.mean)}`);
					}
					for (const warning of result.warnings) console.log(color("yellow", `warning: ${warning}`));
					for (const pr of tracked) console.log(`Tracking ${prName(pr)} (id ${pr.id}): benchboard pr report id:${pr.id}`);
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
				if (action === "track") {
					const pr = options.branch
						? store.syncLocalBranch({ cwd, head: reference, base: options.base })
						: reference ? await store.syncGithubPullRequest({ cwd, reference }) : undefined;
					if (!pr) throw new Error("Usage: benchboard pr track <ref> | --branch [name] [--base ref]");
					if (options.json) json(pr);
					else console.log(`Tracking ${prName(pr)} (id ${pr.id}) with ${store.pullRequestCommits(pr.id).length} commits on base ${pr.baseSha?.slice(0, 10)}.`);
					return 0;
				}
				if (action === "sync") {
					if (!reference) throw new Error("Usage: benchboard pr sync <ref>");
					const pr = await store.resyncPullRequest(resolvePullRequest(store, cwd, reference).id);
					if (options.json) json(pr);
					else console.log(`Synced ${prName(pr)}: ${store.pullRequestCommits(pr.id).length} commits, head ${pr.headSha.slice(0, 10)}.`);
					return 0;
				}
				if (action === "list") {
					const prs = options.all ? store.pullRequests() : store.pullRequests(currentRepository(store, cwd).id);
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
					const report = pullRequestReport(store, resolvePullRequest(store, cwd, reference).id, {
						statistic, threshold, includeDirty: options["include-dirty"],
						machineId: options.machine === undefined ? undefined : Number(options.machine),
					});
					if (options.json) json(report);
					else printReport(store, report);
					return 0;
				}
				throw new Error("Usage: benchboard pr <track|sync|list|report> ...");
			}
			case "profile": {
				const [action, ...args] = rest;
				const iterations = options.iterations === undefined ? undefined : Number(options.iterations);
				if (iterations !== undefined && (!Number.isSafeInteger(iterations) || iterations < 1)) throw new Error("--iterations must be a positive integer.");
				const printProfile = (profile: Profile) => {
					const m = store.measurement(profile.measurementId)!;
					console.log(`Profile ${profile.id} → run ${m.runId} case ${m.position} [${m.caseKey}] @ ${m.commitSha?.slice(0, 10) ?? "?"}: ` +
						`${profile.samples} samples, ${(profile.cpuMs / profile.iterations).toFixed(1)} ms on CPU and ${(profile.sampledMs / profile.iterations).toFixed(1)} ms sampled per iteration` +
						`${profile.cpuSource === "sample-count" ? " (no CPU deltas: CPU estimated from samples)" : ""}, ` +
						`${(profile.symbolicatedShare * 100).toFixed(1)}% symbolicated${profile.symsSha256 ? "" : " (no .syms.json sidecar)"}`);
				};
				if (action === "attach") {
					if (args.length !== 2) throw new Error("Usage: benchboard profile attach <run>[:<case>] <profile.json.gz>");
					const profile = store.attachProfile({
						measurementId: store.measurementByReference(args[0]).id, file: args[1], syms: options.syms, iterations,
						label: options.label, cwd,
					});
					if (options.json) json(profile); else printProfile(profile);
					return 0;
				}
				if (action === "record") {
					if (!args.length) throw new Error("Usage: benchboard profile record <run>[:<case>] [-- command...]");
					const measurement = store.measurementByReference(args[0]);
					const command = args.length > 1 ? args.slice(1) : ["sh", "-c", measurement.command ?? measurement.exportedCommand];
					const directory = fs.mkdtempSync(path.join(os.tmpdir(), "benchboard-samply-"));
					try {
						const output = path.join(directory, "profile.json.gz");
						const samply = Bun.spawnSync(["samply", "record", "--save-only", "--no-open", "--unstable-presymbolicate", "-o", output,
							...(options.rate ? ["--rate", options.rate] : []), ...(iterations ? ["--iteration-count", String(iterations)] : []), ...command],
						{ cwd, stdout: "inherit", stderr: "inherit" });
						if (samply.exitCode !== 0) throw new Error(`samply exited with ${samply.exitCode}; is it installed and set up (\`samply setup\` on macOS)?`);
						const profile = store.attachProfile({
							measurementId: measurement.id, file: output, iterations, label: options.label, command: command.join(" "), cwd,
						});
						if (options.json) json(profile); else printProfile(profile);
					} finally {
						fs.rmSync(directory, { recursive: true, force: true });
					}
					return 0;
				}
				const limit = Number(options.limit ?? 25);
				const load = (value: string | undefined) => {
					const profile = value && store.profile(Number(value));
					if (!profile) throw new Error(`Unknown profile ${value ?? ""}.`);
					return profile;
				};
				const ms = (value: number) => `${value.toFixed(1)} ms`.padStart(11);
				const metric = options.metric === "sampled" ? "sampled" : "cpu";
				if (options.metric !== undefined && options.metric !== "cpu" && options.metric !== "sampled") throw new Error("--metric must be cpu or sampled.");
				const metricLabel = metric === "cpu" ? "on-CPU" : "sampled (incl. off-CPU)";
				if (action === "show") {
					const profile = load(args[0]);
					const tree = store.profileTree(profile.id);
					const scale = 1 / profile.iterations;
					const stats = functionStats(tree, metric).sort((a, b) => b.self - a.self).slice(0, limit)
						.map((stat) => ({ ...stat, self: stat.self * scale, total: stat.total * scale }));
					if (options.json) { json(stats); return 0; }
					printProfile(profile);
					console.log(`${"self".padStart(11)} ${"total".padStart(11)}  function · ${metricLabel} ms per iteration`);
					for (const stat of stats) console.log(`${ms(stat.self)} ${ms(stat.total)}  ${clean(stat.name).slice(0, 120)}${stat.library ? color("dim", `  ${stat.library}`) : ""}`);
					return 0;
				}
				if (action === "diff") {
					const [base, head] = [load(args[0]), load(args[1])];
					const deltas = diffFunctions(store.profileTree(base.id), store.profileTree(head.id), {
						metric, iterations: { base: base.iterations, head: head.iterations },
					}).slice(0, limit);
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
			case "runs": {
				const runs = store.runs({
					repositoryId: options.all ? undefined : currentRepository(store, cwd).id,
					limit: options.limit ? Number(options.limit) : 20,
				});
				if (options.json) json(runs);
				else for (const run of runs) console.log(`${run.id}\t${run.recordedAt}\t${clean(run.title ?? "(untitled)")}`);
				return 0;
			}
			case "query": {
				if (rest.length !== 1) throw new Error("Usage: benchboard query <graphql|@file> [--variables json]");
				const source = rest[0].startsWith("@") ? fs.readFileSync(rest[0].slice(1), "utf8") : rest[0];
				const variableValues = options.variables ? JSON.parse(options.variables) : undefined;
				const result = await graphql({ schema: createSchema(), source, variableValues, contextValue: { store, mayMutate: true } });
				json(result);
				return result.errors?.length ? 1 : 0;
			}
			case "serve":
				return await serve(store, options.host ?? "127.0.0.1", Number(options.port ?? DEFAULT_PORT), options.open ?? false);
			case "open": {
				const port = Number(options.port ?? DEFAULT_PORT);
				await ensureServer(store.home, port, options.home);
				let route = "/";
				if (rest[0] === "pr" && rest[1]) route = `/pr/${resolvePullRequest(store, cwd, rest[1]).id}`;
				else if (rest[0] === "run" && rest[1]) route = `/runs/${rest[1]}`;
				else {
					const repository = store.repositoryForCheckout(cwd);
					if (repository) route = `/repositories/${repository.id}`;
				}
				const url = `http://localhost:${port}${route}`;
				console.log(url);
				open(url);
				return 0;
			}
			case "import-legacy": {
				const directory = path.resolve(rest[0] ?? path.join(os.homedir(), ".pi", "agent", "benchmarks"));
				const result = importLegacy(store, directory);
				if (options.json) json(result);
				else {
					console.log(`Imported ${result.imported}, already present ${result.skipped}, failed ${result.failed.length}.`);
					for (const failure of result.failed) console.log(`  ${failure.id}: ${failure.error}`);
				}
				return result.failed.length ? 1 : 0;
			}
			default:
				throw new Error(`Unknown command "${command}". Run benchboard --help.`);
		}
	} catch (error) {
		console.error(`benchboard: ${(error as Error).message}`);
		return 1;
	} finally {
		store.close();
	}
}
