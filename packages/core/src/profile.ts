import { CallTreeBuilder, THREAD_LIBRARY, type CallTree, type CpuSource } from "./profile-tree.ts";

export const MAX_PROFILE_BYTES = 512 * 1024 * 1024;

/** samply `--unstable-presymbolicate` sidecar (`<profile>.syms.json`). */
export interface SymsSidecar {
	string_table: string[];
	data: {
		debug_name: string;
		debug_id: string;
		code_id?: string;
		symbol_table: { rva: number; size: number; symbol: number; frames?: { function: number; file?: number; line?: number }[] }[];
		known_addresses: [number, number][];
	}[];
}

export interface SymbolFrame {
	name: string;
	file: string | null;
	line: number | null;
}

export interface ParsedProfile {
	tree: CallTree;
	product: string | null;
	durationMs: number | null;
	/** Fraction of non-thread frames, weighted by samples, that resolved to a symbol name. */
	symbolicatedShare: number;
	/** The recording OS as samply reports it, e.g. "macOS 15.3" or "Amazon Linux 2023". */
	platform: string | null;
	/**
	 * Whether threads were also sampled while not running (sleeping, blocked, waiting for I/O), so that
	 * sampled time includes waits. samply does this on macOS; on Linux (perf) and Windows (ETW) it only
	 * samples running threads, so sampled time is on-CPU time. Null when the recording OS is unknown.
	 */
	waitsSampled: boolean | null;
}

const isObject = (value: unknown): value is Record<string, any> => value !== null && typeof value === "object" && !Array.isArray(value);
const hexName = /^0x[0-9a-f]+$/i;
/** samply names functions it found no symbol for `fun_<address>` (e.g. stripped libc on Linux). */
const placeholderName = /^fun_[0-9a-f]+$/i;
export const UNKNOWN_FRAME = "[unknown]";

/** samply samples idle threads only on macOS (see ParsedProfile.waitsSampled). */
export function samplesWaits(platform: string | null): boolean | null {
	if (!platform) return null;
	return /^(macOS|Mac OS X|OS X)\b/i.test(platform);
}

export function decodeProfileBytes(bytes: Uint8Array): unknown {
	if (bytes.length > MAX_PROFILE_BYTES) throw new Error("Profile exceeds 512 MiB.");
	const text = bytes[0] === 0x1f && bytes[1] === 0x8b ? Bun.gunzipSync(new Uint8Array(bytes)) : bytes;
	try {
		return JSON.parse(new TextDecoder().decode(text));
	} catch (error) {
		throw new Error(`Profile is not valid JSON: ${(error as Error).message}`);
	}
}

const normalizeId = (id: string | undefined) => (id ?? "").replace(/-/g, "").toUpperCase().slice(0, 32);

/** Resolves library-relative addresses to symbols (with inlined frames) using the samply sidecar. */
export class Symbolicator {
	private readonly libs: { known: Map<number, number>; sorted: SymsSidecar["data"][number]["symbol_table"]; entry: SymsSidecar["data"][number] }[];
	private readonly byKey = new Map<string, number>();
	private readonly byName = new Map<string, number>();
	readonly strings: string[];

	constructor(syms: SymsSidecar) {
		if (!isObject(syms) || !Array.isArray(syms.string_table) || !Array.isArray(syms.data)) throw new Error("Invalid .syms.json sidecar.");
		this.strings = syms.string_table;
		this.libs = syms.data.map((entry, index) => {
			this.byKey.set(`${entry.debug_name}\0${normalizeId(entry.debug_id)}`, index);
			if (!this.byName.has(entry.debug_name)) this.byName.set(entry.debug_name, index);
			return {
				entry,
				known: new Map(entry.known_addresses.map(([address, symbol]) => [address, symbol])),
				sorted: entry.symbol_table.map((symbol, position) => ({ ...symbol, position })).sort((a, b) => a.rva - b.rva),
			};
		});
	}

	library(debugName: string | undefined, breakpadId: string | undefined): number | undefined {
		if (!debugName) return undefined;
		return this.byKey.get(`${debugName}\0${normalizeId(breakpadId)}`) ?? this.byName.get(debugName);
	}

	/** Frames from outermost (the symbol) to innermost inlined function, or null if unknown. */
	lookup(library: number, address: number): SymbolFrame[] | null {
		return this.resolve(library, address)?.frames ?? null;
	}

	resolve(library: number, address: number): { frames: SymbolFrame[]; rva: number; size: number } | null {
		const lib = this.libs[library];
		let index = lib.known.get(address);
		let symbol = index === undefined ? undefined : lib.entry.symbol_table[index];
		if (!symbol) {
			// Return addresses point after the call; also try the preceding byte.
			for (const target of [address, address - 1]) {
				let lo = 0, hi = lib.sorted.length - 1;
				while (lo <= hi) {
					const mid = (lo + hi) >> 1;
					if (lib.sorted[mid].rva <= target) lo = mid + 1;
					else hi = mid - 1;
				}
				const candidate = lib.sorted[hi];
				if (candidate && target < candidate.rva + Math.max(1, candidate.size)) { symbol = candidate; break; }
			}
		}
		if (!symbol) return null;
		const string = (value: number | undefined) => value === undefined ? null : this.strings[value] ?? null;
		const frames = !symbol.frames?.length ? [{ name: string(symbol.symbol) ?? "?", file: null, line: null }]
			// The sidecar lists inlined frames innermost first; the last entry is the containing function.
			: [...symbol.frames].reverse().map((frame) => ({ name: string(frame.function) ?? "?", file: string(frame.file), line: frame.line ?? null }));
		return { frames, rva: symbol.rva, size: symbol.size };
	}
}

/**
 * Aggregates a Firefox Profiler "processed" profile (as written by `samply record --save-only`)
 * into a call tree, symbolicating hex addresses with an optional samply `.syms.json` sidecar.
 */
export function parseProfile(data: unknown, syms?: SymsSidecar | null, maxNodes?: number): ParsedProfile {
	if (!isObject(data) || !isObject(data.meta) || !Array.isArray(data.threads)) throw new Error("Not a Firefox Profiler profile.");
	if (data.meta.preprocessedProfileVersion === undefined) {
		throw new Error("Only processed profiles are supported (samply's output or a Firefox Profiler upload); this looks like the raw Gecko format.");
	}
	const libs: { name?: string; debugName?: string; breakpadId?: string }[] = Array.isArray(data.libs) ? data.libs : [];
	const symbolicator = syms ? new Symbolicator(syms) : null;
	const libSyms = libs.map((lib) => symbolicator?.library(lib.debugName ?? lib.name, lib.breakpadId));
	const shared = isObject(data.shared) ? data.shared : {};
	const builder = new CallTreeBuilder();
	const threadStats = new Map<string, { samples: number; cpuMs: number; sampledMs: number }>();
	const intervalMs = Number(data.meta.interval) || 1;
	// samply records per-sample CPU deltas in µs (or ns); cycle counts cannot be converted to time.
	const cpuUnit = data.meta.sampleUnits?.threadCPUDelta;
	const cpuScale = cpuUnit === "µs" || cpuUnit === "us" ? 1e-3 : cpuUnit === "ns" ? 1e-6 : null;
	let cpuSource: CpuSource = cpuScale === null ? "sample-count" : "thread-cpu-delta";
	let resolved = 0, unresolved = 0;
	let start = Infinity, end = -Infinity;

	for (const thread of data.threads) {
		if (!isObject(thread) || !isObject(thread.samples) || !isObject(thread.stackTable) || !isObject(thread.frameTable) || !isObject(thread.funcTable)) continue;
		const strings: string[] = thread.stringArray ?? shared.stringArray ?? [];
		const { stackTable, frameTable, funcTable, samples } = thread;
		const resourceTable = isObject(thread.resourceTable) ? thread.resourceTable : { lib: [], name: [] };
		const threadName = String(thread.name ?? thread.processName ?? "thread");
		const root = builder.child(0, builder.func(threadName, THREAD_LIBRARY));
		const frameFuncs: (number[] | undefined)[] = [];
		const frameResolved: boolean[] = [];
		const funcsOf = (frame: number) => {
			let funcs = frameFuncs[frame];
			if (funcs) return funcs;
			const func = frameTable.func[frame];
			const resource = funcTable.resource?.[func] ?? -1;
			const lib = resource >= 0 ? resourceTable.lib?.[resource] ?? null : null;
			const libName = lib !== null && lib !== undefined ? libs[lib]?.name ?? null : resource >= 0 ? strings[resourceTable.name?.[resource]] ?? null : null;
			const raw = strings[funcTable.name[func]] ?? "?";
			// Addresses outside every module cannot be symbolicated and are often unique per sample (on arm64
			// Linux, return addresses still carrying pointer-authentication bits): one "[unknown]" frame keeps
			// flame graphs and call-path diffs from splitting on them.
			const name = resource < 0 && hexName.test(raw) ? UNKNOWN_FRAME : raw;
			const address = frameTable.address?.[frame] ?? -1;
			let symbols: SymbolFrame[] | null = null;
			if (hexName.test(name) && symbolicator && lib !== null && lib !== undefined && libSyms[lib] !== undefined && address >= 0) {
				symbols = symbolicator.lookup(libSyms[lib]!, address);
			}
			frameResolved[frame] = symbols !== null ? symbols.some((symbol) => !placeholderName.test(symbol.name))
				: !hexName.test(raw) && !placeholderName.test(raw);
			funcs = symbols ? symbols.map((symbol) => builder.func(symbol.name, libName)) : [builder.func(name, libName)];
			frameFuncs[frame] = funcs;
			return funcs;
		};
		const stackNodes = new Int32Array(stackTable.length ?? stackTable.frame.length).fill(-1);
		const stackResolved = new Float64Array(stackNodes.length);
		const stackDepth = new Float64Array(stackNodes.length);
		const nodeOf = (stack: number): number => {
			if (stackNodes[stack] >= 0) return stackNodes[stack];
			// Resolve the prefix chain iteratively; deep stacks would overflow recursion.
			const chain: number[] = [];
			for (let s: number | null = stack; s !== null && s !== undefined && stackNodes[s] < 0; s = stackTable.prefix[s]) chain.push(s);
			for (let i = chain.length - 1; i >= 0; i--) {
				const s = chain[i];
				const prefix = stackTable.prefix[s];
				let node = prefix === null || prefix === undefined ? root : stackNodes[prefix];
				const frame = stackTable.frame[s];
				for (const func of funcsOf(frame)) node = builder.child(node, func);
				stackNodes[s] = node;
				const base = prefix === null || prefix === undefined ? 0 : stackResolved[prefix];
				const depth = prefix === null || prefix === undefined ? 0 : stackDepth[prefix];
				stackResolved[s] = base + (frameResolved[frame] ? 1 : 0);
				stackDepth[s] = depth + 1;
			}
			return stackNodes[stack];
		};
		const deltas: (number | null)[] | undefined = Array.isArray(samples.threadCPUDelta) ? samples.threadCPUDelta : undefined;
		if (!deltas && (samples.length ?? samples.stack.length) > 0) cpuSource = "sample-count";
		// Weights are sample counts, except for traced profiles whose weights are already milliseconds.
		const sampleMs = samples.weightType === "tracing-ms" ? 1 : intervalMs;
		const stats = threadStats.get(threadName) ?? { samples: 0, cpuMs: 0, sampledMs: 0 };
		const count = samples.length ?? samples.stack.length;
		for (let i = 0; i < count; i++) {
			const stack = samples.stack[i];
			const weight = samples.weight?.[i] ?? 1;
			const sampled = weight * sampleMs;
			const delta = deltas?.[i];
			// CPU deltas cover the time since the thread's previous sample, so idle samples weigh ~0.
			const cpu = cpuScale !== null && deltas ? (typeof delta === "number" && delta > 0 ? delta * cpuScale : 0) : sampled;
			if (!sampled && !cpu) continue;
			const node = stack === null || stack === undefined ? root : nodeOf(stack);
			builder.add(node, cpu, sampled);
			stats.samples += weight;
			stats.cpuMs += cpu;
			stats.sampledMs += sampled;
			if (stack !== null && stack !== undefined) {
				resolved += sampled * stackResolved[stack];
				unresolved += sampled * (stackDepth[stack] - stackResolved[stack]);
			}
			const time = samples.time?.[i];
			if (typeof time === "number") { start = Math.min(start, time); end = Math.max(end, time); }
		}
		threadStats.set(threadName, stats);
	}
	if (cpuSource === "sample-count") {
		// Without CPU deltas, CPU time can only be estimated from samples; say so rather than pretend.
		for (let node = 0; node < builder.nodes.cpu.length; node++) builder.nodes.cpu[node] = builder.nodes.sampled[node];
		for (const stats of threadStats.values()) stats.cpuMs = stats.sampledMs;
	}
	const threads = [...threadStats].map(([name, stats]) => ({ name, ...stats })).sort((a, b) => b.cpuMs - a.cpuMs || b.sampledMs - a.sampledMs);
	const tree = builder.build({ intervalMs, cpuSource, threads, samples: threads.reduce((sum, thread) => sum + thread.samples, 0) }, maxNodes);
	if (!tree.samples) throw new Error("The profile contains no samples; was the workload too short or did samply lack permission (`samply setup`)?");
	return {
		tree,
		product: typeof data.meta.product === "string" ? data.meta.product : null,
		durationMs: Number.isFinite(end - start) ? end - start : null,
		symbolicatedShare: resolved + unresolved ? resolved / (resolved + unresolved) : 1,
		platform: typeof data.meta.oscpu === "string" && data.meta.oscpu.trim() ? data.meta.oscpu.trim().slice(0, 200) : null,
		waitsSampled: samplesWaits(typeof data.meta.oscpu === "string" ? data.meta.oscpu.trim() : null),
	};
}

/** Tecken-style `/symbolicate/v5` responses so the Firefox Profiler can symbolicate from Benchboard. */
export function symbolicateRequest(syms: SymsSidecar, body: unknown): unknown {
	const symbolicator = new Symbolicator(syms);
	const jobs = isObject(body) && Array.isArray(body.jobs) ? body.jobs : [body];
	return {
		results: jobs.map((job: any) => {
			const memoryMap: [string, string][] = Array.isArray(job?.memoryMap) ? job.memoryMap : [];
			const found: Record<string, boolean> = {};
			const libraries = memoryMap.map(([name, id]) => {
				const library = symbolicator.library(name, id);
				found[`${name}/${id}`] = library !== undefined;
				return library;
			});
			const stacks = (Array.isArray(job?.stacks) ? job.stacks : []).map((stack: [number, number][]) => stack.map(([module, address], frame) => {
				const library = libraries[module];
				const resolved = library === undefined ? null : symbolicator.resolve(library, address);
				const base = { frame, module_offset: `0x${address.toString(16)}`, module: memoryMap[module]?.[0] };
				if (!resolved) return base;
				const outer = resolved.frames[0];
				const inner = resolved.frames.slice(1).reverse();
				return {
					...base, function: outer.name,
					function_offset: `0x${(address - resolved.rva).toString(16)}`, function_size: `0x${resolved.size.toString(16)}`,
					...(inner.length ? {
						// The profiler expects inlined frames innermost first, each with its call site.
						inlines: inner.map((entry) => ({ function: entry.name, file: entry.file ?? undefined, line: entry.line ?? undefined })),
					} : {}),
					file: outer.file ?? undefined, line: outer.line ?? undefined,
				};
			}));
			return { stacks, found_modules: found };
		}),
	};
}
