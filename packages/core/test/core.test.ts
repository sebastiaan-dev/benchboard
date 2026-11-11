import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, test } from "bun:test";

import {
	Store, bootstrapRatio, inferRevision, normalizeRemote, parseHyperfineExport, pullRequestReport, random, slug, statistics,
	verdictFor,
} from "../src/index.ts";

// node:test-style cleanup registration on top of bun:test.
const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });
const t = { after: (fn: () => void) => { cleanups.push(fn); } };

function temporary(t: { after: (fn: () => void) => void }, prefix: string) {
	const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
	t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
	return directory;
}

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], {
	encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@e", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@e" },
}).trim();

function samples(center: number, n: number, seed: number, spread = 0.01) {
	const next = random(seed);
	return Array.from({ length: n }, () => center * (1 + (next() - 0.5) * 2 * spread));
}

function hyperfine(file: string, results: { command: string; times: number[]; exit?: number }[]) {
	fs.writeFileSync(file, JSON.stringify({
		results: results.map(({ command, times, exit = 0 }) => ({ command, times, exit_codes: times.map(() => exit) })),
	}));
}

test("statistics match a sort-based reference and bootstrap is deterministic", () => {
	const values = samples(1, 101, 7);
	const stats = statistics(values);
	const sorted = [...values].sort((a, b) => a - b);
	assert.equal(stats.median, sorted[50]);
	assert.equal(stats.min, sorted[0]);
	const even = statistics(values.slice(0, 100));
	const evenSorted = values.slice(0, 100).sort((a, b) => a - b);
	assert.ok(Math.abs(even.median - (evenSorted[49] + evenSorted[50]) / 2) < 1e-15);
	const a = bootstrapRatio(samples(1.1, 30, 1), samples(1, 30, 2), "median", 42)!;
	const b = bootstrapRatio(samples(1.1, 30, 1), samples(1, 30, 2), "median", 42)!;
	assert.deepEqual(a, b);
	assert.ok(a.low > 1.05 && a.high < 1.15 && a.low <= a.ratio && a.ratio <= a.high);
	const mean = bootstrapRatio(samples(1, 30, 3), samples(1, 30, 4), "mean", 1)!;
	assert.ok(mean.low < 1 && mean.high > 1);
});

test("verdicts require a confident and material change", () => {
	assert.equal(verdictFor(1.10, 1.05, 1.15, 0.02), "regression");
	assert.equal(verdictFor(0.90, 0.85, 0.95, 0.02), "improvement");
	assert.equal(verdictFor(1.01, 0.995, 1.02, 0.02), "unchanged");
	assert.equal(verdictFor(1.10, 0.90, 1.30, 0.02), "inconclusive");
	assert.equal(verdictFor(1.01, 0.70, 1.40, 0.02), "inconclusive");
});

test("hyperfine exports are validated against their samples", () => {
	const ok = Buffer.from(JSON.stringify({ results: [{ command: "a", times: [1, 2, 3], mean: 2, exit_codes: [0, 0, 1] }] }));
	const [entry] = parseHyperfineExport(ok);
	assert.equal(entry.status, "failed");
	assert.equal(entry.median, 2);
	assert.throws(() => parseHyperfineExport(Buffer.from(JSON.stringify({ results: [{ command: "a", times: [1, 2], mean: 5 }] }))), /disagrees/);
	assert.throws(() => parseHyperfineExport(Buffer.from("{}")), /1–512 results/);
	assert.throws(() => parseHyperfineExport(Buffer.from(JSON.stringify({ results: [{ command: "a", times: [-1] }] }))), /nonnegative/);
	const unverified = parseHyperfineExport(Buffer.from(JSON.stringify({ results: [{ command: "a", times: [1] }] })));
	assert.equal(unverified[0].status, "unverified");
});

test("remote normalization and slugs", () => {
	assert.equal(normalizeRemote("git@github.com:duckdb/duckdb.git"), "github.com/duckdb/duckdb");
	assert.equal(normalizeRemote("https://github.com/duckdb/duckdb/"), "github.com/duckdb/duckdb");
	assert.equal(normalizeRemote("ssh://git@gitlab.example.com:22/a/b.git"), "gitlab.example.com/a/b");
	assert.equal(slug("TPC-H Q1 (SF 10)"), "tpc-h-q1-sf-10");
	assert.equal(slug("a/b c", "x", false), "a-b-c");
	assert.equal(slug("!!!"), "default");
});

test("legacy revisions infer commits and dirty state", () => {
	const sha = "c0fcdb86350372dfef6f9358a61c5a6eb12e0868";
	assert.deepEqual(inferRevision(`${sha} + dirty patch`, null), { sha, dirty: true });
	assert.deepEqual(inferRevision(`${sha}, clean source`, null), { sha, dirty: false });
	assert.deepEqual(inferRevision(undefined, null, sha, true), { sha, dirty: true });
});

test("end to end: ingest a commit sweep, track the branch and report regressions", () => {
	const repo = temporary(t, "benchboard-repo-");
	const home = temporary(t, "benchboard-home-");
	git(repo, "init", "-q", "-b", "main");
	git(repo, "remote", "add", "origin", "git@github.com:example/project.git");
	fs.writeFileSync(path.join(repo, "f"), "0");
	git(repo, "add", "f");
	git(repo, "commit", "-qm", "base");
	const base = git(repo, "rev-parse", "HEAD");
	git(repo, "checkout", "-qb", "feature");
	const shas: string[] = [];
	for (const [index, subject] of ["refactor", "speed up", "slow down"].entries()) {
		fs.writeFileSync(path.join(repo, "f"), String(index + 1));
		git(repo, "commit", "-qam", subject);
		shas.push(git(repo, "rev-parse", "HEAD"));
	}

	const store = new Store(home);
	t.after(() => store.close());
	const pr = store.syncLocalBranch({ cwd: repo, base: "main" });
	assert.equal(pr.baseSha, base);
	assert.deepEqual(store.pullRequestCommits(pr.id).map((commit) => commit.sha), shas);
	assert.equal(store.repository(pr.repositoryId)!.slug, "github.com/example/project");
	assert.deepEqual(store.commitPositions(pr.repositoryId, base).map((entry) => entry.position), [0]);
	assert.deepEqual(store.commitPositions(pr.repositoryId, shas[1]).map((entry) => [entry.pullRequest.id, entry.position]), [[pr.id, 2]]);

	// One Hyperfine run sweeping base + all commits for two workloads.
	const centers = [1.0, 1.0, 0.8, 1.2];
	const revisions = [base, ...shas];
	for (const [workload, scale] of [["q1", 1], ["q2", 2]] as const) {
		const file = path.join(home, `${workload}.json`);
		hyperfine(file, revisions.map((sha, index) => ({ command: `./bin-${sha.slice(0, 7)} ${workload}`, times: samples(centers[index] * scale, 25, index + scale) })));
		const result = store.ingest({
			file, cwd: repo,
			metadata: {
				benchmark: "suite/queries", title: "Queries",
				cases: revisions.map((sha) => ({ case: workload, commit: sha.slice(0, 8), name: `${workload} @ ${sha.slice(0, 7)}` })),
			},
		});
		assert.equal(result.measurements.length, 4);
		assert.ok(result.measurements.every((m) => m.caseKey === workload && m.dirty === false && !m.commitInferred));
		assert.deepEqual(result.warnings, []);
	}
	assert.throws(() => store.ingest({ file: path.join(home, "q1.json"), cwd: repo, metadata: {} }), /already ingested/);

	// An extra dirty run on head must be excluded by default.
	const dirtyFile = path.join(home, "dirty.json");
	hyperfine(dirtyFile, [{ command: "wip", times: samples(5, 10, 99) }]);
	store.ingest({ file: dirtyFile, cwd: repo, metadata: { benchmark: "suite/queries", commit: "HEAD", dirty: true, cases: [{ case: "q1" }] } });

	const report = pullRequestReport(store, pr.id);
	assert.equal(report.series.length, 2);
	assert.equal(report.summary.regression, 2);
	for (const series of report.series) {
		assert.ok(series.referenceIsBase);
		assert.equal(series.points.length, 4);
		assert.equal(series.points[2].vsReference!.verdict, "improvement");
		assert.equal(series.points[3].vsPrevious!.verdict, "regression");
		assert.ok(series.latestComparison!.sameRun);
		assert.ok(Math.abs(series.latestComparison!.ratio - 1.2) < 0.03);
		assert.equal(series.latest!.measurement!.dirty, false);
	}
	const withDirty = pullRequestReport(store, pr.id, { includeDirty: true });
	const q1 = withDirty.series.find((series) => series.caseKey === "q1")!;
	assert.equal(q1.points[3].candidates.length, 2);
	assert.equal(q1.points[3].measurement!.dirty, false, "clean measurements stay representative");

	// Defaulting to the checkout HEAD records that the commit was inferred and warns.
	fs.writeFileSync(path.join(repo, "f"), "dirty");
	const headFile = path.join(home, "head.json");
	hyperfine(headFile, [{ command: "x", times: [1, 1.1] }]);
	const defaulted = store.ingest({ file: headFile, cwd: repo, metadata: { benchmark: "other" } });
	assert.equal(defaulted.measurements[0].commitSha, shas[2]);
	assert.equal(defaulted.measurements[0].dirty, true);
	assert.ok(defaulted.measurements[0].commitInferred);
	assert.match(defaulted.warnings[0], /checkout HEAD .* \(dirty\)/);
});

function prRepo(commits: number) {
	const repo = temporary(t, "benchboard-pr-");
	const home = temporary(t, "benchboard-pr-home-");
	git(repo, "init", "-q", "-b", "main");
	fs.writeFileSync(path.join(repo, "f"), "0");
	git(repo, "add", "f");
	git(repo, "commit", "-qm", "base");
	const shas = [git(repo, "rev-parse", "HEAD")];
	git(repo, "checkout", "-qb", "feature");
	for (let i = 1; i <= commits; i++) {
		fs.writeFileSync(path.join(repo, "f"), String(i));
		git(repo, "commit", "-qam", `commit ${i}`);
		shas.push(git(repo, "rev-parse", "HEAD"));
	}
	const store = new Store(home);
	t.after(() => store.close());
	const pr = store.syncLocalBranch({ cwd: repo, base: "main" });
	let exports = 0;
	/** Ingests one Hyperfine run; each case is [commit index, sample times, dirty?]. */
	const run = (cases: [number, number[], boolean?][], recordedAt: string) => {
		const file = path.join(home, `${++exports}.json`);
		hyperfine(file, cases.map(([index, times]) => ({ command: `c${index}`, times })));
		return store.ingest({
			file, cwd: repo, allowDuplicate: true, internal: { recordedAt },
			metadata: { benchmark: "b", cases: cases.map(([index, , dirty]) => ({ case: "q", commit: shas[index], dirty: dirty ?? false })) },
		});
	};
	return { store, pr, run, shas };
}

test("comparisons use the commit's representative and report exactly the measurements compared", () => {
	const { store, pr, run } = prRepo(1);
	run([[0, samples(1, 20, 1)], [1, samples(2, 20, 2)]], "2026-01-01T00:00:00Z"); // older same-invocation pair
	const newer = run([[1, samples(0.5, 20, 3)]], "2026-01-02T00:00:00Z");     // newer head on its own
	const [series] = pullRequestReport(store, pr.id).series;
	const comparison = series.headComparison!;
	assert.equal(comparison.candidate.id, newer.measurements[0].id, "the newest head measurement is authoritative");
	assert.equal(series.head!.measurement!.id, comparison.candidate.id);
	assert.equal(comparison.pairing, "representatives");
	assert.equal(comparison.alternatives, 1);
	assert.ok(Math.abs(comparison.ratio - 0.5) < 0.02, String(comparison.ratio));
	assert.equal(comparison.verdict, "improvement");
});

test("same-invocation pairing never displaces clean measurements with dirty ones", () => {
	const { store, pr, run } = prRepo(1);
	const clean = run([[0, samples(1, 20, 1)], [1, samples(1.5, 20, 2)]], "2026-01-01T00:00:00Z");
	run([[0, samples(1, 20, 3), true], [1, samples(0.5, 20, 4), true]], "2026-01-02T00:00:00Z");
	const comparison = pullRequestReport(store, pr.id, { includeDirty: true }).series[0].headComparison!;
	assert.equal(comparison.candidate.id, clean.measurements[1].id);
	assert.equal(comparison.baseline.id, clean.measurements[0].id);
	assert.equal(comparison.pairing, "same-invocation");
	assert.equal(comparison.candidate.dirty, false);
});

test("cached comparisons are invalidated by deletes, re-ingests and writes from other processes", () => {
	const { store, pr, run, shas } = prRepo(1);
	run([[0, samples(1, 20, 1)]], "2026-01-01T00:00:00Z");
	const head = run([[1, samples(2, 20, 2)]], "2026-01-02T00:00:00Z");
	assert.ok(Math.abs(pullRequestReport(store, pr.id).series[0].headComparison!.ratio - 2) < 0.05);
	store.deleteRun(head.run.id);
	const replacement = run([[1, samples(0.5, 20, 3)]], "2026-01-03T00:00:00Z");
	assert.equal(replacement.measurements[0].id, head.measurements[0].id, "SQLite reuses the row ID");
	assert.ok(Math.abs(pullRequestReport(store, pr.id).series[0].headComparison!.ratio - 0.5) < 0.02);
	// Another connection (e.g. the CLI while the server runs) deletes the head measurement.
	const other = new Store(store.home);
	other.deleteRun(replacement.run.id);
	other.close();
	const after = pullRequestReport(store, pr.id).series[0];
	assert.equal(after.head, null);
	assert.equal(after.points.find((point) => point.sha === shas[1])!.measurement, null);
});

test("too few samples give a descriptive ratio without an interval or verdict", () => {
	const { store, pr, run } = prRepo(1);
	run([[0, [1]], [1, [2]]], "2026-01-01T00:00:00Z");
	const comparison = pullRequestReport(store, pr.id).series[0].headComparison!;
	assert.equal(comparison.ratio, 2);
	assert.equal(comparison.low, null);
	assert.equal(comparison.high, null);
	assert.equal(comparison.verdict, "insufficient");
	assert.equal(pullRequestReport(store, pr.id).summary.insufficient, 1);
});

test("the head verdict requires a head measurement, and steps across gaps are marked", () => {
	const { store, pr, run } = prRepo(3);
	run([[0, samples(1, 20, 1)], [1, samples(0.8, 20, 2)]], "2026-01-01T00:00:00Z");
	const report = pullRequestReport(store, pr.id);
	const [series] = report.series;
	assert.equal(series.head, null);
	assert.equal(series.headComparison, null);
	assert.equal(series.verdict, null);
	assert.equal(series.latest!.position, 1);
	assert.equal(series.latestComparison!.verdict, "improvement");
	assert.equal(report.summary.missingHead, 1);
	assert.equal(report.summary.improvement, 0, "a commit before the head is not a head verdict");

	run([[3, samples(0.8, 20, 3)]], "2026-01-02T00:00:00Z");
	const head = pullRequestReport(store, pr.id).series[0];
	const point = head.points.find((entry) => entry.position === 3)!;
	assert.equal(head.head!.position, 3);
	assert.equal(point.previousPosition, 1);
	assert.equal(point.spansGap, true);
	assert.equal(head.points.find((entry) => entry.position === 1)!.spansGap, false);
});

test("measurements recorded elsewhere keep their machine identity, with unknown fields left unknown", () => {
	const { store, run } = prRepo(1);
	const file = path.join(store.home, "remote.json");
	hyperfine(file, [{ command: "x", times: [1, 1.1, 1.2] }]);
	const remote = store.ingest({ file, cwd: store.home, metadata: { machine: { hostname: "ci-x86", os: "linux 6.11" } } });
	assert.deepEqual(
		(({ hostname, os, arch, cpu, ram }) => ({ hostname, os, arch, cpu, ram }))(store.machine(remote.run.machineId)!),
		{ hostname: "ci-x86", os: "linux 6.11", arch: "unknown", cpu: "unknown", ram: 0 },
	);
	const local = run([[0, [1, 1.1, 1.2]]], "2026-01-01T00:00:00Z");
	assert.notEqual(local.run.machineId, remote.run.machineId);
});

test("run and profile listings page and search by title, SHA prefix and benchmark", () => {
	const { store, run, shas } = prRepo(1);
	for (let i = 0; i < 7; i++) run([[i % 2, [1, 1.1, 1.2]]], `2026-01-0${i + 1}T00:00:00Z`);
	const repositoryId = store.repositories()[0].id;
	assert.equal(store.runCount({ repositoryId }), 7);
	const pages = [0, 3, 6].map((offset) => store.runs({ repositoryId, limit: 3, offset }).map((r) => r.id));
	assert.deepEqual(pages.map((page) => page.length), [3, 3, 1]);
	assert.equal(new Set(pages.flat()).size, 7);
	assert.equal(store.runCount({ repositoryId, search: shas[1].slice(0, 8) }), 3);
	assert.equal(store.runCount({ repositoryId, search: "B" }), 7, "benchmark key, case-insensitive");
	assert.equal(store.runCount({ repositoryId, search: "50%_" }), 0, "LIKE wildcards are escaped");
	assert.equal(store.profileCount(repositoryId), 0);
});
