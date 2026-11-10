import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
	Store, bootstrapRatio, inferRevision, normalizeRemote, parseHyperfineExport, pullRequestReport, random, slug, statistics,
	verdictFor,
} from "../src/index.ts";

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

test("end to end: ingest a commit sweep, track the branch and report regressions", (t) => {
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
