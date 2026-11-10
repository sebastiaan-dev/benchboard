import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, test } from "bun:test";
import {
	Store, diffFunctions, diffTrees, functionStats, mergeThreads, parseProfile, prune, sidecarPath, symbolicateRequest,
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
	assert.deepEqual(parsed.tree.threads, [{ name: "worker", samples: 160 }, { name: "main", samples: 5 }]);
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
	assert.equal(pruned.nodes.total[0], parsed.tree.samples, "Pruning folds samples into parents.");
});

test("profile diffs attribute CPU-time changes to functions and call paths", () => {
	const base = parseProfile(workload(60).profile, workload(60).syms as SymsSidecar).tree;
	const head = parseProfile(workload(15).profile, workload(15).syms as SymsSidecar).tree;
	const [top] = diffFunctions(base, head);
	assert.equal(top.name, "CompareKeys");
	assert.equal(top.baseSelfMs, 120);
	assert.equal(top.headSelfMs, 30);
	const tree = diffTrees(base, head, { base: 2, head: 1 });
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
