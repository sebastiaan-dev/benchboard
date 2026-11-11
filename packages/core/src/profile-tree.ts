/**
 * Compact call trees aggregated from sampled profiles. Pure functions, safe to use in the browser.
 *
 * A tree stores columnar arrays. Node 0 is the root; its children are one node per thread name;
 * below that come frames from outermost to innermost (inlined frames expanded). Parents always
 * precede their children, so a reverse scan accumulates totals.
 *
 * Every node carries two self weights in milliseconds:
 * - `cpu`: time on CPU, from the profiler's per-sample thread CPU deltas;
 * - `sampled`: sampled time (samples × interval), which includes waiting, sleeping and blocking.
 * When the profile has no CPU deltas, `cpu` repeats `sampled` and `cpuSource` says so.
 */
export interface CallTree {
	version: 2;
	strings: string[];
	/** Function name and library (string indices; -1 when unknown). */
	funcs: { name: number[]; lib: number[] };
	nodes: { func: number[]; parent: number[]; cpu: number[]; sampled: number[] };
	cpuSource: CpuSource;
	intervalMs: number;
	/** Number of samples (sum of sample weights). */
	samples: number;
	cpuMs: number;
	sampledMs: number;
	threads: { name: string; samples: number; cpuMs: number; sampledMs: number }[];
}

/** `thread-cpu-delta`: measured CPU time; `sample-count`: estimated from samples (includes off-CPU time). */
export type CpuSource = "thread-cpu-delta" | "sample-count";
export type Metric = "cpu" | "sampled";

/** Bumped whenever aggregation changes; older profiles are re-aggregated from their raw files. 3: platform, waits; 4: [unknown] frames. */
export const TREE_VERSION = 4;
export const THREAD_LIBRARY = "(thread)";

export function functionName(tree: Pick<CallTree, "strings" | "funcs">, func: number): string {
	return func < 0 ? "(root)" : tree.strings[tree.funcs.name[func]] ?? "?";
}

export function functionLibrary(tree: Pick<CallTree, "strings" | "funcs">, func: number): string | null {
	const lib = func < 0 ? -1 : tree.funcs.lib[func];
	return lib < 0 ? null : tree.strings[lib];
}

export function isThread(tree: Pick<CallTree, "strings" | "funcs">, func: number): boolean {
	return functionLibrary(tree, func) === THREAD_LIBRARY;
}

export function childrenOf(tree: { nodes: { parent: number[] } }): number[][] {
	const children: number[][] = tree.nodes.parent.map(() => []);
	for (let node = 1; node < tree.nodes.parent.length; node++) children[tree.nodes.parent[node]].push(node);
	return children;
}

/** Inclusive totals for one metric. */
export function totals(tree: CallTree, metric: Metric): Float64Array {
	const self = tree.nodes[metric];
	const result = Float64Array.from(self);
	for (let node = result.length - 1; node > 0; node--) result[tree.nodes.parent[node]] += result[node];
	return result;
}

/** Incrementally builds a tree; `child` merges nodes with the same function under one parent. */
export class CallTreeBuilder {
	readonly strings: string[] = [];
	private readonly stringIndex = new Map<string, number>();
	private readonly funcIndex = new Map<string, number>();
	private readonly childIndex = new Map<string, number>();
	readonly funcs = { name: [] as number[], lib: [] as number[] };
	readonly nodes = { func: [-1], parent: [-1], cpu: [0], sampled: [0] };

	string(value: string): number {
		let index = this.stringIndex.get(value);
		if (index === undefined) {
			index = this.strings.push(value) - 1;
			this.stringIndex.set(value, index);
		}
		return index;
	}

	func(name: string, lib: string | null): number {
		const key = `${name}\0${lib ?? ""}`;
		let index = this.funcIndex.get(key);
		if (index === undefined) {
			index = this.funcs.name.push(this.string(name)) - 1;
			this.funcs.lib.push(lib === null ? -1 : this.string(lib));
			this.funcIndex.set(key, index);
		}
		return index;
	}

	child(parent: number, func: number): number {
		const key = `${parent}:${func}`;
		let node = this.childIndex.get(key);
		if (node === undefined) {
			node = this.nodes.func.push(func) - 1;
			this.nodes.parent.push(parent);
			this.nodes.cpu.push(0);
			this.nodes.sampled.push(0);
			this.childIndex.set(key, node);
		}
		return node;
	}

	add(node: number, cpu: number, sampled: number) {
		this.nodes.cpu[node] += cpu;
		this.nodes.sampled[node] += sampled;
	}

	build(meta: Pick<CallTree, "intervalMs" | "cpuSource" | "samples" | "threads">, maxNodes = 250_000): CallTree {
		const tree: CallTree = {
			version: 2, strings: this.strings, funcs: this.funcs, nodes: this.nodes, ...meta,
			cpuMs: this.nodes.cpu.reduce((sum, value) => sum + value, 0),
			sampledMs: this.nodes.sampled.reduce((sum, value) => sum + value, 0),
		};
		return prune(tree, maxNodes);
	}
}

/**
 * Drops the lightest subtrees (by sampled time, which bounds CPU time) until at most maxNodes
 * remain, folding their weights into the parent's self time so totals stay exact.
 */
export function prune(tree: CallTree, maxNodes: number): CallTree {
	const count = tree.nodes.func.length;
	if (count <= maxNodes) return tree;
	const weight = totals(tree, "sampled");
	const cpu = totals(tree, "cpu");
	// Children never outweigh parents, so the heaviest nodes (ties broken by index, parents first) form a connected tree.
	const order = Array.from({ length: count }, (_, node) => node).sort((a, b) => weight[b] - weight[a] || a - b);
	const keep = new Uint8Array(count);
	for (let i = 0; i < maxNodes; i++) keep[order[i]] = 1;
	const remap = new Int32Array(count).fill(-1);
	const out = { func: [] as number[], parent: [] as number[], cpu: [] as number[], sampled: [] as number[] };
	for (let node = 0; node < count; node++) {
		const parent = tree.nodes.parent[node];
		if (node === 0 || (remap[parent] >= 0 && keep[node] === 1)) {
			remap[node] = out.func.push(tree.nodes.func[node]) - 1;
			out.parent.push(node === 0 ? -1 : remap[parent]);
			out.cpu.push(tree.nodes.cpu[node]);
			out.sampled.push(tree.nodes.sampled[node]);
		} else if (remap[parent] >= 0) {
			out.cpu[remap[parent]] += cpu[node];
			out.sampled[remap[parent]] += weight[node];
		}
	}
	return { ...tree, nodes: out };
}

/** Collapses the per-thread level so identical stacks from different threads merge; optionally keeps only some threads. */
export function mergeThreads(tree: CallTree, threads?: ReadonlySet<string>): CallTree {
	const builder = new CallTreeBuilder();
	const children = childrenOf(tree);
	const funcMap = new Map<number, number>();
	const mapFunc = (func: number) => {
		let mapped = funcMap.get(func);
		if (mapped === undefined) funcMap.set(func, mapped = builder.func(functionName(tree, func), functionLibrary(tree, func)));
		return mapped;
	};
	const stack: [number, number][] = [];
	for (const thread of children[0]) {
		if (threads && !threads.has(functionName(tree, tree.nodes.func[thread]))) continue;
		stack.push([thread, 0]);
	}
	while (stack.length) {
		const [node, target] = stack.pop()!;
		builder.add(target, tree.nodes.cpu[node], tree.nodes.sampled[node]);
		for (const child of children[node]) stack.push([child, builder.child(target, mapFunc(tree.nodes.func[child]))]);
	}
	const kept = tree.threads.filter((thread) => !threads || threads.has(thread.name));
	return builder.build({
		intervalMs: tree.intervalMs, cpuSource: tree.cpuSource, threads: kept,
		samples: kept.reduce((sum, thread) => sum + thread.samples, 0),
	}, Infinity);
}

export interface FunctionStat {
	name: string;
	library: string | null;
	/** Milliseconds in the function itself. */
	self: number;
	/** Milliseconds with this function anywhere on the stack, counting recursion once. */
	total: number;
}

export function functionStats(tree: CallTree, metric: Metric = "cpu"): FunctionStat[] {
	const inclusive = totals(tree, metric);
	const selfWeights = tree.nodes[metric];
	const self = new Map<number, number>();
	const total = new Map<number, number>();
	const children = childrenOf(tree);
	const active = new Map<number, number>();
	// Iterative DFS keeps very deep stacks off the JS call stack.
	const stack: [node: number, exit: boolean][] = [[0, false]];
	while (stack.length) {
		const [node, exit] = stack.pop()!;
		const func = tree.nodes.func[node];
		if (exit) {
			const depth = active.get(func)! - 1;
			if (depth) active.set(func, depth);
			else active.delete(func);
			continue;
		}
		if (func >= 0 && !isThread(tree, func)) {
			self.set(func, (self.get(func) ?? 0) + selfWeights[node]);
			if (!active.has(func)) total.set(func, (total.get(func) ?? 0) + inclusive[node]);
			active.set(func, (active.get(func) ?? 0) + 1);
			stack.push([node, true]);
		}
		for (const child of children[node]) stack.push([child, false]);
	}
	return [...total.keys()].map((func) => ({
		name: functionName(tree, func), library: functionLibrary(tree, func), self: self.get(func) ?? 0, total: total.get(func)!,
	}));
}

export function metricTotal(tree: CallTree, metric: Metric): number {
	return metric === "cpu" ? tree.cpuMs : tree.sampledMs;
}

export interface FunctionDelta {
	name: string;
	library: string | null;
	baseSelfMs: number;
	headSelfMs: number;
	baseTotalMs: number;
	headTotalMs: number;
	baseSelfShare: number;
	headSelfShare: number;
}

export interface DiffOptions {
	metric?: Metric;
	iterations?: { base?: number; head?: number };
	/**
	 * The profiled program's library on each side; detected from the trees (see mainProgram) when
	 * omitted. Base and head builds are often different files (`./duckdb-main`, `./duckdb-pr`); their
	 * frames are matched by function name as if they were one library, reported under the head's name.
	 */
	programs?: { base?: string | null; head?: string | null };
}

/**
 * The profiled program's executable: the library that defines `main` (the heaviest one if several
 * do), which is independent of how it was launched (`sh -c ./duckdb` reports `sh` as the product).
 */
export function mainProgram(tree: CallTree): string | null {
	let best: FunctionStat | null = null;
	for (const stat of functionStats(tree, "sampled")) {
		if (stat.name === "main" && stat.library && stat.library !== THREAD_LIBRARY && (!best || stat.total > best.total)) best = stat;
	}
	return best?.library ?? null;
}

/** Maps the base program's library name to the head's, so the same function in both builds lines up. */
function baseLibraryAlias(base: CallTree, head: CallTree, options: DiffOptions): (library: string | null) => string | null {
	const from = options.programs?.base ?? mainProgram(base), to = options.programs?.head ?? mainProgram(head);
	if (!from || !to || from === to) return (library) => library;
	return (library) => library === from ? to : library;
}

/** Per-function change between two profiles (milliseconds per iteration), sorted by absolute self-time change. */
export function diffFunctions(base: CallTree, head: CallTree, options: DiffOptions = {}): FunctionDelta[] {
	const metric = options.metric ?? "cpu";
	const key = (stat: FunctionStat) => `${stat.name}\0${stat.library ?? ""}`;
	const alias = baseLibraryAlias(base, head, options);
	const a = new Map(functionStats(base, metric).map((stat) => ({ ...stat, library: alias(stat.library) })).map((stat) => [key(stat), stat]));
	const b = new Map(functionStats(head, metric).map((stat) => [key(stat), stat]));
	const scale = { base: 1 / Math.max(1, options.iterations?.base ?? 1), head: 1 / Math.max(1, options.iterations?.head ?? 1) };
	const totalA = metricTotal(base, metric), totalB = metricTotal(head, metric);
	const deltas = [...new Set([...a.keys(), ...b.keys()])].map((id): FunctionDelta => {
		const x = a.get(id);
		const y = b.get(id);
		const stat = (x ?? y)!;
		return {
			name: stat.name, library: stat.library,
			baseSelfMs: (x?.self ?? 0) * scale.base, headSelfMs: (y?.self ?? 0) * scale.head,
			baseTotalMs: (x?.total ?? 0) * scale.base, headTotalMs: (y?.total ?? 0) * scale.head,
			baseSelfShare: totalA ? (x?.self ?? 0) / totalA : 0,
			headSelfShare: totalB ? (y?.self ?? 0) / totalB : 0,
		};
	});
	return deltas.sort((p, q) => Math.abs(q.headSelfMs - q.baseSelfMs) - Math.abs(p.headSelfMs - p.baseSelfMs));
}

/** Two trees merged by call path, with per-iteration milliseconds on each side (for differential flame graphs). */
export interface DiffTree {
	strings: string[];
	funcs: { name: number[]; lib: number[] };
	nodes: { func: number[]; parent: number[]; base: number[]; head: number[]; baseSelf: number[]; headSelf: number[] };
}

export function diffTrees(base: CallTree, head: CallTree, options: DiffOptions = {}): DiffTree {
	const metric = options.metric ?? "cpu";
	const builder = new CallTreeBuilder();
	const base_ = [0], head_ = [0], baseSelf = [0], headSelf = [0];
	const grow = (node: number) => {
		while (base_.length <= node) { base_.push(0); head_.push(0); baseSelf.push(0); headSelf.push(0); }
	};
	const alias = baseLibraryAlias(base, head, options);
	const add = (tree: CallTree, scale: number, total: number[], selfs: number[], library: (name: string | null) => string | null) => {
		const children = childrenOf(tree);
		const inclusive = totals(tree, metric);
		const self = tree.nodes[metric];
		const funcs = new Map<number, number>();
		const stack: [number, number][] = [[0, 0]];
		while (stack.length) {
			const [node, target] = stack.pop()!;
			grow(target);
			total[target] += inclusive[node] * scale;
			selfs[target] += self[node] * scale;
			for (const child of children[node]) {
				const func = tree.nodes.func[child];
				let mapped = funcs.get(func);
				if (mapped === undefined) funcs.set(func, mapped = builder.func(functionName(tree, func), library(functionLibrary(tree, func))));
				stack.push([child, builder.child(target, mapped)]);
			}
		}
	};
	add(base, 1 / Math.max(1, options.iterations?.base ?? 1), base_, baseSelf, alias);
	add(head, 1 / Math.max(1, options.iterations?.head ?? 1), head_, headSelf, (name) => name);
	grow(builder.nodes.func.length - 1);
	return {
		strings: builder.strings, funcs: builder.funcs,
		nodes: { func: builder.nodes.func, parent: builder.nodes.parent, base: base_, head: head_, baseSelf, headSelf },
	};
}
