import type { Benchmark, Commit, Machine, Measurement, Profile, Repository, Run, Store } from "@benchboard/core";

export interface Context {
	store: Store;
	/** Whether the caller may run mutations: true in-process, or with the server's session token over HTTP. */
	mayMutate: boolean;
	loaders: Loaders;
}

export function createContext(store: Store, mayMutate: boolean): Context {
	return { store, mayMutate, loaders: new Loaders(store) };
}

/**
 * Per-request memoization and batching, so nested fields (a run's measurements, their benchmarks,
 * machines and profiles; repository benchmark histories) cost a handful of queries, not one each.
 */
export class Loaders {
	private readonly memo = new Map<string, unknown>();
	private readonly store: Store;

	constructor(store: Store) {
		this.store = store;
	}

	private once<T>(key: string, load: () => T): T {
		if (this.memo.has(key)) return this.memo.get(key) as T;
		const value = load();
		this.memo.set(key, value);
		return value;
	}

	repository(id: number): Repository | undefined {
		return this.once(`repository:${id}`, () => this.store.repository(id));
	}
	benchmark(id: number): Benchmark | undefined {
		return this.once(`benchmark:${id}`, () => this.store.benchmark(id));
	}
	machine(id: number): Machine | undefined {
		return this.once(`machine:${id}`, () => this.store.machine(id));
	}
	run(id: string): Run | undefined {
		return this.once(`run:${id}`, () => this.store.run(id));
	}
	runMeasurements(runId: string): Measurement[] {
		return this.once(`runMeasurements:${runId}`, () => {
			const measurements = this.store.runMeasurements(runId);
			this.primeProfiles(measurements.map((measurement) => measurement.id));
			return measurements;
		});
	}
	/** Loads the measurements (and their profiles) of a page of runs in two queries. */
	primeRuns(runs: Run[]): Run[] {
		const missing = runs.filter((run) => !this.memo.has(`runMeasurements:${run.id}`));
		const measurements = this.store.measurementsForRuns(missing.map((run) => run.id));
		for (const [runId, list] of measurements) this.memo.set(`runMeasurements:${runId}`, list);
		this.primeProfiles([...measurements.values()].flat().map((measurement) => measurement.id));
		for (const run of runs) this.memo.set(`run:${run.id}`, run);
		return runs;
	}
	/** Commit rows are optional (e.g. a SHA recorded without local git); fall back to a bare commit. */
	commit(repositoryId: number, sha: string): Commit {
		return this.once(`commit:${repositoryId}:${sha}`, () => this.store.commit(repositoryId, sha) ?? {
			repositoryId, sha, parents: [], subject: null, author: null, authoredAt: null, committedAt: null,
		});
	}
	profiles(measurementId: number): Profile[] {
		return this.once(`profiles:${measurementId}`, () => this.store.profilesForMeasurement(measurementId));
	}
	primeProfiles(measurementIds: number[]) {
		const missing = measurementIds.filter((id) => !this.memo.has(`profiles:${id}`));
		for (const [id, profiles] of this.store.profilesForMeasurements(missing)) this.memo.set(`profiles:${id}`, profiles);
	}
	benchmarkCases(repositoryId: number, benchmarkId: number) {
		const all = this.once(`cases:${repositoryId}`, () => this.store.benchmarkCasesForRepository(repositoryId));
		return all.get(benchmarkId) ?? [];
	}
	/** Recent measurements of a series; one windowed query serves every series of the repository. */
	seriesMeasurements(repositoryId: number, benchmarkId: number, caseKey: string, limit: number): Measurement[] {
		const all = this.once(`series:${repositoryId}:${limit}`, () => {
			const map = this.store.recentSeriesMeasurements(repositoryId, limit);
			this.primeProfiles([...map.values()].flat().map((measurement) => measurement.id));
			return map;
		});
		return all.get(`${benchmarkId}\0${caseKey}`) ?? [];
	}
}
