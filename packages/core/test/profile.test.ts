import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, test } from "bun:test";
import {
	Store, decodeProfileBytes, diffFunctions, diffTrees, functionStats, mainProgram, mergeThreads, parseProfile, prune, sidecarPath,
	symbolicateRequest, totals,
	type SymsSidecar,
} from "../src/index.ts";
import { syntheticProfile } from "./synthetic-profile.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

const workload = (probe: number) => syntheticProfile("engine", [
	{ name: "main", stacks: [{ frames: ["main", "Run"], samples: 5 }] },
	...["worker", "worker"].map((name) => ({
		name, stacks: [
			{ frames: ["main", "Run", "HashJoin::Probe|ProbeChunk", "CompareKeys"], samples: probe },
			{ frames: ["main", "Run", "HashJoin::Build"], samples: 20 },
		],
	})),
]);

test("samply profiles are symbolicated with inlined frames and aggregated per thread", () => {
	const { profile, syms } = workload(60);
	const unsymbolicated = parseProfile(profile, null);
	assert.equal(unsymbolicated.symbolicatedShare, 0);
	const parsed = parseProfile(profile, syms as SymsSidecar);
	assert.equal(parsed.symbolicatedShare, 1);
	assert.equal(parsed.tree.samples, 5 + 2 * 80);
	assert.deepEqual(parsed.tree.threads, [
		{ name: "worker", samples: 160, cpuMs: 160, sampledMs: 160 }, { name: "main", samples: 5, cpuMs: 5, sampledMs: 5 },
	]);
	const stats = new Map(functionStats(parsed.tree).map((stat) => [stat.name, stat]));
	// The inlined ProbeChunk frame expands below its containing HashJoin::Probe symbol.
	assert.equal(stats.get("HashJoin::Probe")!.total, 120);
	assert.equal(stats.get("ProbeChunk")!.total, 120);
	assert.equal(stats.get("CompareKeys")!.self, 120);
	assert.equal(stats.get("main")!.total, 165);
	assert.equal(stats.get("worker"), undefined, "Thread nodes are not functions.");
	const merged = mergeThreads(parsed.tree);
	assert.equal(merged.samples, 165);
	assert.equal(functionStats(merged).find((stat) => stat.name === "Run")!.total, 165);
	assert.equal(mergeThreads(parsed.tree, new Set(["main"])).samples, 5);
	const pruned = prune(parsed.tree, 4);
	assert.equal(pruned.nodes.func.length, 4);
	assert.equal(totals(pruned, "sampled")[0], parsed.tree.sampledMs, "Pruning folds samples into parents.");
	assert.equal(totals(pruned, "cpu")[0], parsed.tree.cpuMs);
	assert.equal(parsed.tree.cpuSource, "sample-count", "Synthetic profiles have no CPU deltas, so CPU is an estimate.");
});

const fixture = (name: string) => {
	const file = path.join(import.meta.dir, "fixtures", `${name}.json.gz`);
	return parseProfile(decodeProfileBytes(fs.readFileSync(file)), JSON.parse(fs.readFileSync(sidecarPath(file), "utf8")));
};

test("real samply profiles separate on-CPU time from sleeping and blocking", () => {
	// Python sleeping for 2 s: ~2 s sampled, ~25 ms on CPU, the sleep itself almost free.
	const sleep = fixture("samply-python-sleep").tree;
	assert.equal(sleep.cpuSource, "thread-cpu-delta");
	assert.ok(sleep.sampledMs > 1900 && sleep.sampledMs < 2200, String(sleep.sampledMs));
	assert.ok(sleep.cpuMs > 15 && sleep.cpuMs < 60, String(sleep.cpuMs));
	const wait = functionStats(sleep, "cpu").find((stat) => stat.name === "__semwait_signal")!;
	assert.ok(wait.self < 1, `sleeping is not CPU time (${wait.self} ms)`);
	assert.ok(functionStats(sleep, "sampled").find((stat) => stat.name === "__semwait_signal")!.self > 1900);

	// Two threads contend on a mutex while main joins: blocked time is sampled but not CPU.
	const locks = fixture("samply-locks").tree;
	const byThread = new Map(locks.threads.map((thread) => [thread.name, thread]));
	assert.equal(locks.threads.length, 3);
	const main = byThread.get("locks")!;
	assert.ok(main.cpuMs < 20 && main.sampledMs > 500, JSON.stringify(main));
	const cpu = new Map(functionStats(locks, "cpu").map((stat) => [stat.name, stat]));
	const sampled = new Map(functionStats(locks, "sampled").map((stat) => [stat.name, stat]));
	assert.ok(cpu.get("spin")!.self > 800, "computation is CPU time");
	const blocked = ["__psynch_mutexwait", "__ulock_wait", "__ulock_wait2", "__psynch_cvwait"].map((name) => sampled.get(name)?.self ?? 0).reduce((a, b) => a + b, 0);
	assert.ok(blocked > 500, `waiting shows up in sampled time (${blocked} ms)`);
	const blockedCpu = ["__psynch_mutexwait", "__ulock_wait", "__ulock_wait2", "__psynch_cvwait"].map((name) => cpu.get(name)?.self ?? 0).reduce((a, b) => a + b, 0);
	assert.ok(blockedCpu < 20, `but barely any CPU (${blockedCpu} ms)`);
	assert.ok(Math.abs(totals(locks, "cpu")[0] - locks.cpuMs) < 1e-6);
});

test("profile diffs attribute CPU-time changes to functions and call paths", () => {
	const base = parseProfile(workload(60).profile, workload(60).syms as SymsSidecar).tree;
	const head = parseProfile(workload(15).profile, workload(15).syms as SymsSidecar).tree;
	const [top] = diffFunctions(base, head);
	assert.equal(top.name, "CompareKeys");
	assert.equal(top.baseSelfMs, 120);
	assert.equal(top.headSelfMs, 30);
	const tree = diffTrees(base, head, { iterations: { base: 2, head: 1 } });
	assert.equal(tree.nodes.base[0], 165 / 2);
	assert.equal(tree.nodes.head[0], 75);
});

test("profiles attach to measurements with their sidecar and answer Firefox Profiler symbol requests", () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "benchboard-profile-"));
	cleanups.push(() => fs.rmSync(home, { recursive: true, force: true }));
	const { profile, syms } = workload(60);
	const file = path.join(home, "probe.json.gz");
	fs.writeFileSync(file, Bun.gzipSync(new TextEncoder().encode(JSON.stringify(profile))));
	fs.writeFileSync(sidecarPath(file), JSON.stringify(syms));
	assert.equal(sidecarPath(file), path.join(home, "probe.json.syms.json"));
	const exportFile = path.join(home, "bench.json");
	fs.writeFileSync(exportFile, JSON.stringify({ results: [{ command: "probe", times: [1, 1.1], exit_codes: [0, 0] }] }));
	const store = new Store(home);
	cleanups.push(() => store.close());
	const { measurements } = store.ingest({
		file: exportFile, cwd: home, metadata: { benchmark: "join/probe", cases: [{ profile: { file: "probe.json.gz", iterations: 2, label: "perf" } }] },
	});
	const [attached] = store.profilesForMeasurement(measurements[0].id);
	assert.equal(attached.iterations, 2);
	assert.equal(attached.symbolicatedShare, 1);
	assert.ok(attached.symsSha256);
	assert.ok(fs.existsSync(store.profileFile(attached)));
	assert.equal(store.profileTree(attached.id).samples, 165);
	assert.equal(store.profilesForSeries(measurements[0].benchmarkId, measurements[0].caseKey)[0].id, attached.id);

	const symbols = syms as SymsSidecar;
	const address = symbols.data[0].symbol_table[2].rva + 0x14;
	const response = symbolicateRequest(symbols, {
		jobs: [{ memoryMap: [["engine", profile.libs[0].breakpadId]], stacks: [[[0, address], [0, 1]]] }],
	}) as any;
	const [frame, unknown] = response.results[0].stacks[0];
	assert.equal(frame.function, "HashJoin::Probe");
	assert.deepEqual(frame.inlines.map((entry: any) => entry.function), ["ProbeChunk"]);
	assert.equal(frame.function_offset, "0x14");
	assert.equal(unknown.function, undefined);
	assert.equal(response.results[0].found_modules[`engine/${profile.libs[0].breakpadId}`], true);
	store.deleteRun(measurements[0].runId);
	assert.equal(store.profile(attached.id), undefined, "Profiles are deleted with their run.");
});

test("Linux samply profiles: on-CPU only, waits not sampled, placeholder names unsymbolicated", () => {
	const linux = fixture("samply-linux-threads");
	assert.equal(linux.platform, "Debian GNU/Linux 12 (bookworm)");
	assert.equal(linux.waitsSampled, false);
	assert.equal(linux.tree.cpuSource, "thread-cpu-delta");
	// Three threads named after the process merge into one; the sleeps (3 × 150 ms) are invisible.
	const work = linux.tree.threads.find((thread) => thread.name === "work")!;
	assert.ok(Math.abs(work.sampledMs - work.cpuMs) < 2, JSON.stringify(work));
	assert.ok(work.cpuMs > 150 && work.cpuMs < 400, String(work.cpuMs));
	const cpu = new Map(functionStats(linux.tree, "cpu").map((stat) => [stat.name, stat]));
	assert.ok(cpu.get("compare_keys")!.self / linux.tree.cpuMs > 0.95);
	assert.ok(cpu.get("probe")!.total / linux.tree.cpuMs > 0.95, "frame pointers give complete stacks");
	assert.ok(cpu.has("fun_81d50"), "placeholders keep their name");
	assert.ok(linux.symbolicatedShare < 1, "but do not count as symbolicated");
	assert.equal(fixture("samply-locks").waitsSampled, true);
});

test("diffs match functions of differently named base and head executables", () => {
	const build = (program: string, compare: number) => {
		const { profile, syms } = syntheticProfile(program, [{ name: "worker", stacks: [{ frames: ["main", "Probe", "CompareKeys"], samples: compare }] }]);
		return parseProfile(profile, syms as SymsSidecar).tree;
	};
	const [base, head] = [build("duckdb-main", 40), build("duckdb-pr", 10)];
	// The program is the library defining main, whatever samply's product name (e.g. `sh` for `sh -c`).
	assert.equal(mainProgram(base), "duckdb-main");
	assert.equal(diffFunctions(base, head).filter((entry) => entry.name === "CompareKeys").length, 1, "detected automatically");
	const separate = diffFunctions(base, head, { programs: { base: "unrelated", head: "other" } }).filter((entry) => entry.name === "CompareKeys");
	assert.equal(separate.length, 2, "with unrelated program names, they stay different libraries");
	const [top] = diffFunctions(base, head, { programs: { base: "duckdb-main", head: "duckdb-pr" } });
	assert.deepEqual([top.name, top.library, top.baseSelfMs, top.headSelfMs], ["CompareKeys", "duckdb-pr", 40, 10]);
	const tree = diffTrees(base, head, { programs: { base: "duckdb-main", head: "duckdb-pr" } });
	const names = tree.funcs.name.map((index) => tree.strings[index]);
	assert.equal(names.filter((name) => name === "CompareKeys").length, 1, "one merged call path");
});

test("addresses outside every module collapse into one [unknown] frame", () => {
	const { tree, platform } = fixture("samply-linux-pac");
	assert.match(platform!, /^Amazon Linux 2023/);
	const names = tree.funcs.name.map((index) => tree.strings[index]);
	assert.equal(names.filter((name) => /^0x[0-9a-f]{10,}$/.test(name)).length, 0, "no per-sample garbage addresses");
	const unknown = functionStats(tree, "cpu").find((stat) => stat.name === "[unknown]")!;
	assert.ok(unknown.total / tree.cpuMs > 0.95, "it is the common root of the stacks");
	assert.ok(functionStats(tree, "cpu").find((stat) => stat.name === "compare_keys")!.self / tree.cpuMs > 0.95);
});
