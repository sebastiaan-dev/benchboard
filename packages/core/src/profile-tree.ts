/**
 * Compact call trees aggregated from sampled profiles. Pure functions, safe to use in the browser.
 *
 * A tree stores columnar arrays. Node 0 is the root; its children are one node per thread name;
 * below that come frames from outermost to innermost (inlined frames expanded). Parents always
 * precede their children, so a reverse scan accumulates totals.
 */
export interface CallTree {
	version: 1;
	strings: string[];
	/** Function name and library (string indices; -1 when unknown). */
	funcs: { name: number[]; lib: number[] };
	nodes: { func: number[]; parent: number[]; self: number[]; total: number[] };
	/** Sampling interval; one sample ≈ intervalMs of CPU time on its thread. */
	intervalMs: number;
	samples: number;
	threads: { name: string; samples: number }[];
}

export const THREAD_LIBRARY = "(thread)";

export function functionName(tree: CallTree, func: number): string {
	return func < 0 ? "(root)" : tree.strings[tree.funcs.name[func]] ?? "?";
}

export function functionLibrary(tree: CallTree, func: number): string | null {
	const lib = func < 0 ? -1 : tree.funcs.lib[func];
	return lib < 0 ? null : tree.strings[lib];
}

export function isThread(tree: CallTree, func: number): boolean {
	return functionLibrary(tree, func) === THREAD_LIBRARY;
}

export function childrenOf(tree: CallTree): number[][] {
	const children: number[][] = tree.nodes.func.map(() => []);
	for (let node = 1; node < tree.nodes.parent.length; node++) children[tree.nodes.parent[node]].push(node);
	return children;
}

/** Incrementally builds a tree; `child` merges nodes with the same function under one parent. */
export class CallTreeBuilder {
	readonly strings: string[] = [];
	private readonly stringIndex = new Map<string, number>();
	private readonly funcIndex = new Map<string, number>();
	private readonly childIndex = new Map<string, number>();
	readonly funcs = { name: [] as number[], lib: [] as number[] };
	readonly nodes = { func: [-1], parent: [-1], self: [0], total: [0] };

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
			this.nodes.self.push(0);
			this.nodes.total.push(0);
			this.childIndex.set(key, node);
		}
		return node;
	}

	addSelf(node: number, weight: number) {
		this.nodes.self[node] += weight;
	}

	build(meta: { intervalMs: number; threads: { name: string; samples: number }[] }, maxNodes = 250_000): CallTree {
		const { self, total, parent } = this.nodes;
		for (let node = 0; node < self.length; node++) total[node] = self[node];
		for (let node = self.length - 1; node > 0; node--) total[parent[node]] += total[node];
		const tree: CallTree = {
			version: 1, strings: this.strings, funcs: this.funcs, nodes: this.nodes,
			intervalMs: meta.intervalMs, samples: total[0], threads: meta.threads,
		};
		return prune(tree, maxNodes);
	}
}

/** Drops the lightest subtrees until at most maxNodes remain, folding their samples into the parent's self time. */
export function prune(tree: CallTree, maxNodes: number): CallTree {
	const count = tree.nodes.func.length;
	if (count <= maxNodes) return tree;
	// Children never outweigh parents, so the heaviest nodes (ties broken by index, parents first) form a connected tree.
	const order = Array.from({ length: count }, (_, node) => node)
		.sort((a, b) => tree.nodes.total[b] - tree.nodes.total[a] || a - b);
	const keep = new Uint8Array(count);
	for (let i = 0; i < maxNodes; i++) keep[order[i]] = 1;
	const remap = new Int32Array(count).fill(-1);
	const out = { func: [] as number[], parent: [] as number[], self: [] as number[], total: [] as number[] };
	for (let node = 0; node < count; node++) {
		const parent = tree.nodes.parent[node];
		const kept = node === 0 || (remap[parent] >= 0 && keep[node] === 1);
		if (kept) {
			remap[node] = out.func.push(tree.nodes.func[node]) - 1;
			out.parent.push(node === 0 ? -1 : remap[parent]);
			out.self.push(tree.nodes.self[node]);
			out.total.push(tree.nodes.total[node]);
		} else if (remap[parent] >= 0) {
			out.self[remap[parent]] += tree.nodes.total[node];
		}
	}
	return { ...tree, nodes: out };
}

/** Collapses the per-thread level so identical stacks from different threads merge. */
export function mergeThreads(tree: CallTree, threads?: ReadonlySet<string>): CallTree {
	const builder = new CallTreeBuilder();
	const children = childrenOf(tree);
	const funcMap = new Map<number, number>();
	const mapFunc = (func: number) => {
		let mapped = funcMap.get(func);
		if (mapped === undefined) funcMap.set(func, mapped = builder.func(functionName(tree, func), functionLibrary(tree, func)));
		return mapped;
	};
	const visit = (node: number, target: number) => {
		builder.addSelf(target, tree.nodes.self[node]);
		for (const child of children[node]) visit(child, builder.child(target, mapFunc(tree.nodes.func[child])));
	};
	let samples = 0;
	for (const thread of children[0]) {
		const name = functionName(tree, tree.nodes.func[thread]);
		if (threads && !threads.has(name)) continue;
		samples += tree.nodes.total[thread];
		visit(thread, 0);
	}
	const merged = builder.build({ intervalMs: tree.intervalMs, threads: tree.threads.filter((t) => !threads || threads.has(t.name)) }, Infinity);
	return { ...merged, samples };
}

export interface FunctionStat {
	name: string;
	library: string | null;
	self: number;
	/** Samples with this function anywhere on the stack, counting recursion once. */
	total: number;
}

export function functionStats(tree: CallTree): FunctionStat[] {
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
			self.set(func, (self.get(func) ?? 0) + tree.nodes.self[node]);
			if (!active.has(func)) total.set(func, (total.get(func) ?? 0) + tree.nodes.total[node]);
			active.set(func, (active.get(func) ?? 0) + 1);
			stack.push([node, true]);
		}
		for (const child of children[node]) stack.push([child, false]);
	}
	return [...total.keys()].map((func) => ({
		name: functionName(tree, func), library: functionLibrary(tree, func), self: self.get(func) ?? 0, total: total.get(func)!,
	}));
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

/** CPU milliseconds per iteration represented by one sample of the tree. */
export const sampleMs = (tree: CallTree, iterations = 1) => tree.intervalMs / Math.max(1, iterations);

/** Per-function change between two profiles, sorted by absolute self-time change. */
export function diffFunctions(base: CallTree, head: CallTree, iterations: { base?: number; head?: number } = {}): FunctionDelta[] {
	const key = (stat: FunctionStat) => `${stat.name}\0${stat.library ?? ""}`;
	const a = new Map(functionStats(base).map((stat) => [key(stat), stat]));
	const b = new Map(functionStats(head).map((stat) => [key(stat), stat]));
	const ms = { base: sampleMs(base, iterations.base), head: sampleMs(head, iterations.head) };
	const deltas = [...new Set([...a.keys(), ...b.keys()])].map((id): FunctionDelta => {
		const x = a.get(id);
		const y = b.get(id);
		const stat = (x ?? y)!;
		return {
			name: stat.name, library: stat.library,
			baseSelfMs: (x?.self ?? 0) * ms.base, headSelfMs: (y?.self ?? 0) * ms.head,
			baseTotalMs: (x?.total ?? 0) * ms.base, headTotalMs: (y?.total ?? 0) * ms.head,
			baseSelfShare: base.samples ? (x?.self ?? 0) / base.samples : 0,
			headSelfShare: head.samples ? (y?.self ?? 0) / head.samples : 0,
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

export function diffTrees(base: CallTree, head: CallTree, iterations: { base?: number; head?: number } = {}): DiffTree {
	const builder = new CallTreeBuilder();
	const base_ = [0], head_ = [0], baseSelf = [0], headSelf = [0];
	const grow = (node: number) => {
		while (base_.length <= node) { base_.push(0); head_.push(0); baseSelf.push(0); headSelf.push(0); }
	};
	const add = (tree: CallTree, scale: number, total: number[], selfs: number[]) => {
		const children = childrenOf(tree);
		const funcs = new Map<number, number>();
		const stack: [number, number][] = [[0, 0]];
		while (stack.length) {
			const [node, target] = stack.pop()!;
			grow(target);
			total[target] += tree.nodes.total[node] * scale;
			selfs[target] += tree.nodes.self[node] * scale;
			for (const child of children[node]) {
				const func = tree.nodes.func[child];
				let mapped = funcs.get(func);
				if (mapped === undefined) funcs.set(func, mapped = builder.func(functionName(tree, func), functionLibrary(tree, func)));
				stack.push([child, builder.child(target, mapped)]);
			}
		}
	};
	add(base, sampleMs(base, iterations.base), base_, baseSelf);
	add(head, sampleMs(head, iterations.head), head_, headSelf);
	grow(builder.nodes.func.length - 1);
	return {
		strings: builder.strings, funcs: builder.funcs,
		nodes: { func: builder.nodes.func, parent: builder.nodes.parent, base: base_, head: head_, baseSelf, headSelf },
	};
}
