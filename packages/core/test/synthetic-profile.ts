/**
 * Builds Firefox Profiler "processed" profiles in the shape `samply record --save-only
 * --unstable-presymbolicate` writes (hex function names + a `.syms.json` sidecar).
 */
export interface SyntheticStack {
	/** Outermost first. `"outer|inner"` is one native frame where `inner` was inlined into `outer`. */
	frames: string[];
	samples: number;
	/** Fraction of each sample spent on CPU (default 1); 0 models waiting or sleeping. */
	cpu?: number;
}

export interface SyntheticThread {
	name: string;
	stacks: SyntheticStack[];
}

export function syntheticProfile(product: string, threads: SyntheticThread[], library = product, options: { cpuDeltas?: boolean } = {}) {
	const breakpadId = "4A1E0B5C9D2F4E6A8B7C1D3E5F708192" + "0";
	const symbols = new Map<string, { rva: number; size: number; frames: string[] }>();
	let next = 0x1000;
	const symbolFor = (frame: string) => {
		let symbol = symbols.get(frame);
		if (!symbol) {
			const parts = frame.split("|");
			symbol = { rva: next, size: 0x200, frames: parts };
			next += 0x200;
			symbols.set(frame, symbol);
		}
		return symbol;
	};
	let time = 0;
	const profileThreads = threads.map((thread, threadIndex) => {
		const stringArray: string[] = [];
		const string = (value: string) => {
			const index = stringArray.indexOf(value);
			return index >= 0 ? index : stringArray.push(value) - 1;
		};
		const frameTable = { length: 0, address: [] as number[], inlineDepth: [] as number[], category: [] as number[], subcategory: [] as number[],
			func: [] as number[], nativeSymbol: [] as null[], innerWindowID: [] as null[], implementation: [] as null[], line: [] as null[], column: [] as null[] };
		const funcTable = { length: 0, name: [] as number[], isJS: [] as boolean[], relevantForJS: [] as boolean[], resource: [] as number[],
			fileName: [] as null[], lineNumber: [] as null[], columnNumber: [] as null[] };
		const stackTable = { length: 0, prefix: [] as (number | null)[], frame: [] as number[], category: [] as number[], subcategory: [] as number[] };
		const samples = { length: 0, weightType: "samples", stack: [] as number[], time: [] as number[], weight: [] as number[],
			...(options.cpuDeltas ? { threadCPUDelta: [] as number[] } : {}) };
		const frameIndex = new Map<number, number>();
		const stackIndex = new Map<string, number>();
		const frameOf = (address: number) => {
			let frame = frameIndex.get(address);
			if (frame === undefined) {
				funcTable.name.push(string(`0x${address.toString(16)}`));
				funcTable.isJS.push(false); funcTable.relevantForJS.push(false); funcTable.resource.push(0);
				funcTable.fileName.push(null); funcTable.lineNumber.push(null); funcTable.columnNumber.push(null);
				funcTable.length++;
				frame = frameTable.length++;
				frameTable.address.push(address); frameTable.inlineDepth.push(0); frameTable.category.push(1); frameTable.subcategory.push(0);
				frameTable.func.push(funcTable.length - 1); frameTable.nativeSymbol.push(null); frameTable.innerWindowID.push(null);
				frameTable.implementation.push(null); frameTable.line.push(null); frameTable.column.push(null);
				frameIndex.set(address, frame);
			}
			return frame;
		};
		for (const stack of thread.stacks) {
			let prefix: number | null = null;
			let key = "";
			stack.frames.forEach((name, depth) => {
				// Distinct return addresses per call depth, like real call sites.
				const address = symbolFor(name).rva + 0x10 + (depth % 8) * 4;
				key += `/${address}`;
				let index = stackIndex.get(key);
				if (index === undefined) {
					index = stackTable.length++;
					stackTable.prefix.push(prefix); stackTable.frame.push(frameOf(address)); stackTable.category.push(1); stackTable.subcategory.push(0);
					stackIndex.set(key, index);
				}
				prefix = index;
			});
			for (let i = 0; i < stack.samples; i++) {
				samples.stack.push(prefix!); samples.time.push(time += 1); samples.weight.push(1); samples.length++;
				// samply reports CPU deltas in µs since the thread's previous sample (interval = 1 ms).
				samples.threadCPUDelta?.push(Math.round(1000 * (stack.cpu ?? 1)));
			}
		}
		string(library);
		return {
			name: thread.name, processName: product, isMainThread: threadIndex === 0, pid: "4242", tid: 4242 + threadIndex,
			processType: "default", registerTime: 0, unregisterTime: null, processStartupTime: 0, processShutdownTime: null,
			pausedRanges: [], showMarkersInTimeline: false, markers: { length: 0, category: [], data: [], endTime: [], name: [], phase: [], startTime: [] },
			stringArray, frameTable, funcTable, stackTable, samples,
			resourceTable: { length: 1, lib: [0], name: [string(library)], host: [null], type: [1] },
			nativeSymbols: { length: 0, address: [], functionSize: [], libIndex: [], name: [] },
		};
	});
	const profile = {
		meta: { version: 24, preprocessedProfileVersion: 49, interval: 1, startTime: 0, product, symbolicated: false,
			sampleUnits: { time: "ms", eventDelay: "ms", threadCPUDelta: "µs" },
			categories: [{ name: "Other", color: "grey", subcategories: ["Other"] }, { name: "User", color: "yellow", subcategories: ["Other"] }] },
		libs: [{ name: library, debugName: library, breakpadId, codeId: breakpadId.slice(0, 32), path: `/opt/${library}`, debugPath: `/opt/${library}`, arch: "arm64" }],
		threads: profileThreads, pages: [], counters: [], profilerOverhead: [],
	};
	const table: string[] = ["UNKNOWN"];
	const string = (value: string) => {
		const index = table.indexOf(value);
		return index >= 0 ? index : table.push(value) - 1;
	};
	const entries = [...symbols.values()].sort((a, b) => a.rva - b.rva);
	const syms = {
		string_table: table,
		data: [{
			debug_name: library, debug_id: breakpadId.slice(0, 32), code_id: breakpadId.slice(0, 32),
			// The sidecar lists inlined frames innermost first; the last entry is the containing symbol.
			symbol_table: entries.map((entry) => ({
				rva: entry.rva, size: entry.size, symbol: string(entry.frames[0]),
				frames: [...entry.frames].reverse().map((name) => ({ function: string(name), file: string("src/execution/join.cpp"), line: 100 + (entry.rva % 300) })),
			})),
			known_addresses: [] as [number, number][],
		}],
	};
	return { profile, syms };
}
