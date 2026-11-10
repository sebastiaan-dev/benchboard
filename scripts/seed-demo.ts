/**
 * Creates a synthetic repository, a feature branch tracked as a local PR and realistic Hyperfine
 * exports across its commits. Usage: BENCHBOARD_HOME=/tmp/benchboard-demo node scripts/seed-demo.ts
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { Store, defaultHome, random } from "@benchboard/core";

const home = defaultHome();
const repo = path.join(home, "demo-repo");
fs.rmSync(repo, { recursive: true, force: true });
fs.mkdirSync(repo, { recursive: true });
let clock = Date.parse("2026-11-02T09:00:00Z");
const git = (...args: string[]) => {
	const date = new Date(clock).toISOString();
	return execFileSync("git", ["-C", repo, ...args], {
		encoding: "utf8",
		env: { ...process.env, GIT_AUTHOR_NAME: "Ada Lovelace", GIT_AUTHOR_EMAIL: "ada@example.com", GIT_COMMITTER_NAME: "Ada Lovelace",
			GIT_COMMITTER_EMAIL: "ada@example.com", GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
	}).trim();
};

git("init", "-q", "-b", "main");
git("remote", "add", "origin", "git@github.com:example/vectorized-engine.git");
fs.writeFileSync(path.join(repo, "engine.c"), "// v0\n");
git("add", ".");
git("commit", "-qm", "Initial engine");
const base = git("rev-parse", "HEAD");
git("checkout", "-qb", "feat/vectorized-probe");
const subjects = [
	"Introduce selection vectors in hash join probe",
	"Vectorize hash probe with SIMD key comparison",
	"Prefetch hash buckets during probe",
	"Inline string comparison in join keys",
	"Refactor: split probe into match and gather phases",
	"Avoid redundant hashing for q9 composite keys",
	"Tune batch size to 2048",
];
const commits = [base];
for (const [index, subject] of subjects.entries()) {
	clock += 5 * 3600_000;
	fs.writeFileSync(path.join(repo, "engine.c"), `// v${index + 1}\n`);
	git("commit", "-qam", subject);
	commits.push(git("rev-parse", "HEAD"));
}

// Multiplicative effect of each commit (index 0 = base) on each series.
const effects: Record<string, number[]> = {
	"tpch/sf1:q1": [1, 1, 0.97, 0.97, 0.97, 0.98, 0.98, 0.96],
	"tpch/sf1:q3": [1, 0.96, 0.84, 0.80, 0.80, 0.80, 0.80, 0.78],
	"tpch/sf1:q6": [1, 1, 1, 1.01, 1, 1, 1, 0.99],
	"tpch/sf1:q9": [1, 0.97, 0.88, 0.86, 0.93, 0.93, 0.82, 0.81],
	"tpch/sf1:q18": [1, 0.95, 0.83, 0.79, 0.80, 0.86, 0.86, 0.84],
	"micro/hash-join:build": [1, 1.02, 1.02, 1.02, 1.02, 1.03, 1.01, 1.01],
	"micro/hash-join:probe": [1, 0.92, 0.64, 0.55, 0.55, 0.56, 0.55, 0.52],
	"micro/strings:like-prefix": [1, 1, 1, 1, 0.71, 0.72, 0.72, 0.72],
};
const centers: Record<string, number> = {
	"tpch/sf1:q1": 0.412, "tpch/sf1:q3": 0.188, "tpch/sf1:q6": 0.061, "tpch/sf1:q9": 0.733, "tpch/sf1:q18": 0.921,
	"micro/hash-join:build": 0.0312, "micro/hash-join:probe": 0.0548, "micro/strings:like-prefix": 0.0089,
};
const next = random(2026);
const sample = (center: number, n: number, noise: number, drift = 1) => Array.from({ length: n }, () => {
	// Right-skewed timing noise with occasional outliers, like real process benchmarks.
	const jitter = (next() + next() + next() - 1.5) * noise;
	const outlier = next() < 0.04 ? 1 + next() * noise * 6 : 1;
	return center * drift * (1 + jitter) * outlier;
});

fs.rmSync(path.join(home, "benchboard.db"), { force: true });
fs.rmSync(path.join(home, "benchboard.db-wal"), { force: true });
fs.rmSync(path.join(home, "benchboard.db-shm"), { force: true });
const store = new Store(home);
const exports = path.join(home, "demo-exports");
fs.mkdirSync(exports, { recursive: true });
let exported = 0;
const ingest = (
	benchmark: string, title: string, cases: { key: string; position: number; dirty?: boolean }[], options: {
		n?: number; noise?: number; drift?: number; machine?: { hostname: string; os: string; arch: string; cpu: string; ram: number };
		recordedAt: number;
	},
) => {
	const file = path.join(exports, `${++exported}.json`);
	const results = cases.map(({ key, position, dirty }) => {
		const series = `${benchmark}:${key}`;
		const times = sample(centers[series] * effects[series][position] * (dirty ? 1.06 : 1), options.n ?? 20, options.noise ?? 0.03, options.drift);
		const mean = times.reduce((a, b) => a + b, 0) / times.length;
		return { command: `./build/release/engine --bench ${series} # ${commits[position].slice(0, 8)}`, mean, times, exit_codes: times.map(() => 0) };
	});
	fs.writeFileSync(file, JSON.stringify({ results }));
	store.ingest({
		file, cwd: repo,
		metadata: {
			benchmark, title,
			conditions: "Warm OS cache, 8 threads, CPU governor performance, fresh process per run.",
			environment: options.machine ? `${options.machine.cpu}, ${options.machine.os}` : "Apple M5 Pro, macOS 26.7, Apple Clang 21",
			invocation: `hyperfine --warmup 3 --runs ${options.n ?? 20} --export-json ${path.basename(file)}`,
			warmup: 3, build: "cmake -G Ninja -DCMAKE_BUILD_TYPE=RelWithDebInfo",
			machine: options.machine ?? { hostname: "bench-m5", os: "darwin 25.6.0", arch: "arm64", cpu: "Apple M5 Pro", ram: 51539607552 },
			cases: cases.map(({ key, position, dirty }) => ({
				case: key, commit: commits[position], dirty: dirty ?? false, name: `${key} @ ${commits[position].slice(0, 7)}${dirty ? "+dirty" : ""}`,
			})),
		},
		internal: { recordedAt: new Date(options.recordedAt).toISOString() },
	});
};

let recorded = Date.parse("2026-11-03T08:00:00Z");
const tpch = ["q1", "q3", "q6", "q9", "q18"];
// Per-commit runs as the branch evolved (cross-run comparisons, slight session drift).
for (let position = 0; position < commits.length; position++) {
	recorded += 3 * 3600_000;
	const drift = 1 + (next() - 0.5) * 0.01;
	if (position !== 3) ingest("tpch/sf1", "TPC-H SF1", tpch.map((key) => ({ key, position })), { recordedAt: recorded, drift, n: 15 });
	ingest("micro/hash-join", "Hash join microbenchmarks", ["build", "probe"].map((key) => ({ key, position })), { recordedAt: recorded + 60_000, drift, n: 40, noise: 0.02 });
	if (position === 0 || position >= 3) {
		ingest("micro/strings", "String predicates", [{ key: "like-prefix", position }], { recordedAt: recorded + 120_000, drift, n: 60, noise: 0.05 });
	}
}
// A final interleaved base-vs-head run: the most trustworthy comparison for the PR.
recorded += 3600_000;
ingest("tpch/sf1", "TPC-H SF1 base vs head", tpch.flatMap((key) => [{ key, position: 0 }, { key, position: commits.length - 1 }]), { recordedAt: recorded, n: 30 });
// Work in progress on top of head (excluded unless dirty builds are included).
ingest("micro/hash-join", "Hash join WIP", [{ key: "probe", position: commits.length - 1, dirty: true }], { recordedAt: recorded + 600_000, n: 20 });
// A second machine with partial coverage.
const linux = { hostname: "ci-x86", os: "linux 6.11", arch: "x64", cpu: "AMD EPYC 9454P", ram: 274877906944 };
for (const position of [0, 2, 7]) {
	ingest("tpch/sf1", "TPC-H SF1 (CI)", tpch.map((key) => ({ key, position })), { recordedAt: recorded + position * 1000, machine: linux, n: 10, noise: 0.05, drift: 1.35 });
}

const pr = store.syncLocalBranch({ cwd: repo, base: "main", title: "Vectorized hash join probe" });
console.log(`Seeded ${exported} runs in ${home}; tracked ${pr.headRef} as id ${pr.id}.`);
store.close();
