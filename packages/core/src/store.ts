import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import type { Database } from "bun:sqlite";
import { openDatabase } from "./db.ts";
import { parseHyperfineExport, type ExportedCase, type CaseStatus } from "./hyperfine.ts";
import { parseMetadata, slug, type IngestMetadata, type MachineMetadata } from "./metadata.ts";
import { githubRemotes, repositoryIdentity, resolveCommit, type CommitInfo, type RepositoryIdentity } from "./git.ts";
import { parsePullRequestReference, snapshotGithubPullRequest } from "./github.ts";
import {
	parsePreparedProfile, parsePreparedRun, parsePullRequestSnapshot, prepareProfile, prepareRun, snapshotLocalBranch,
	type IngestInput, type PreparedProfile, type PreparedRun, type ProfileInput, type PullRequestSnapshot,
} from "./prepare.ts";
import { decodeProfileBytes, parseProfile, type SymsSidecar } from "./profile.ts";
import { TREE_VERSION, type CallTree, type CpuSource } from "./profile-tree.ts";

export interface Repository {
	id: number;
	slug: string;
	name: string;
	remoteUrl: string | null;
	githubRepo: string | null;
	localPath: string | null;
	createdAt: string;
}
export interface Commit extends CommitInfo {
	repositoryId: number;
}
export type PullRequestSource = "github" | "local";
export interface PullRequest {
	id: number;
	repositoryId: number;
	source: PullRequestSource;
	githubRepo: string | null;
	number: number | null;
	title: string;
	url: string | null;
	state: string;
	author: string | null;
	headRef: string;
	headSha: string;
	baseRef: string;
	baseSha: string | null;
	updatedAt: string | null;
	syncedAt: string;
}
export interface Benchmark {
	id: number;
	repositoryId: number;
	key: string;
	title: string | null;
	description: string | null;
}
export interface Machine extends MachineMetadata {
	id: number;
	fingerprint: string;
}
export interface Run {
	id: string;
	repositoryId: number;
	machineId: number;
	recordedAt: string;
	title: string | null;
	conditions: string | null;
	environment: string | null;
	invocation: string | null;
	warmup: number | null;
	notes: string | null;
	baselinePosition: number | null;
	exportSha256: string;
	sourcePath: string | null;
	checkoutPath: string | null;
	checkoutHead: string | null;
	checkoutBranch: string | null;
	checkoutDirty: boolean | null;
	legacyId: string | null;
}
export interface Measurement {
	id: number;
	runId: string;
	position: number;
	benchmarkId: number;
	caseKey: string;
	label: string;
	command: string | null;
	exportedCommand: string;
	commitSha: string | null;
	dirty: boolean | null;
	commitInferred: boolean;
	revision: string | null;
	build: string | null;
	notes: string | null;
	parameters: Record<string, string> | null;
	status: CaseStatus;
	n: number;
	mean: number;
	stddev: number | null;
	median: number;
	min: number;
	max: number;
	q1: number;
	q3: number;
	p95: number;
	cv: number | null;
	userTime: number | null;
	systemTime: number | null;
	rssMedian: number | null;
	rssPeak: number | null;
	/** Recording time of the owning run, denormalized for ordering. */
	recordedAt: string;
	machineId: number;
}

export interface Profile {
	id: number;
	measurementId: number;
	label: string | null;
	tool: string;
	sha256: string;
	symsSha256: string | null;
	product: string | null;
	iterations: number;
	samples: number;
	intervalMs: number;
	durationMs: number | null;
	/** Measured on-CPU time, summed over threads (or estimated from samples, see cpuSource). */
	cpuMs: number;
	/** Sampled time (samples × interval) summed over threads, including waiting and sleeping. */
	sampledMs: number;
	cpuSource: CpuSource;
	threads: { name: string; samples: number; cpuMs: number; sampledMs: number }[];
	symbolicatedShare: number;
	nodeCount: number;
	command: string | null;
	recordedAt: string;
}

export interface AttachProfileInput extends ProfileInput {
	measurementId: number;
}

export interface RunQuery {
	repositoryId?: number;
	benchmarkId?: number;
	limit?: number;
	offset?: number;
	/** Run ID or title, commit SHA prefix (5+ hex characters), benchmark key, case key or label. */
	search?: string;
}

export interface IngestOptions {
	/** Record an export that was already ingested. */
	allowDuplicate?: boolean;
	/**
	 * The run was prepared on another machine (uploaded to a server): its checkout path is kept as
	 * provenance, but never recorded as this repository's local checkout.
	 */
	remote?: boolean;
}
export interface IngestResult {
	run: Run;
	measurements: Measurement[];
	benchmark: Benchmark;
	repository: Repository;
	warnings: string[];
}

type Row = Record<string, string | number | null>;

const camel = (key: string) => key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
function mapRow<T>(row: unknown, convert: Record<string, (value: any) => unknown> = {}): T {
	const result: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(row as Row)) {
		const name = camel(key);
		result[name] = convert[name] ? convert[name](value) : value;
	}
	return result as T;
}
const bool = (value: number | null) => value === null ? null : value !== 0;
const json = (value: string | null) => value === null ? null : JSON.parse(value);

const MEASUREMENT_COLUMNS = `m.id, m.run_id, m.position, m.benchmark_id, m.case_key, m.label, m.command, m.exported_command,
	m.commit_sha, m.dirty, m.commit_inferred, m.revision, m.build, m.notes, m.parameters, m.status, m.n, m.mean, m.stddev,
	m.median, m.min, m.max, m.q1, m.q3, m.p95, m.cv, m.user_time, m.system_time, m.rss_median, m.rss_peak,
	r.recorded_at, r.machine_id`;
const toMeasurement = (row: unknown) => mapRow<Measurement>(row, {
	dirty: bool, commitInferred: (value: number) => value !== 0, parameters: json,
});
const toRun = (row: unknown) => mapRow<Run>(row, { checkoutDirty: bool });
const toCommit = (row: unknown) => mapRow<Commit>(row, { parents: (value: string) => JSON.parse(value) });
const PROFILE_COLUMNS = `id, measurement_id, label, tool, sha256, syms_sha256, product, iterations, samples, interval_ms, duration_ms,
	cpu_ms, sampled_ms, cpu_source,
	threads, symbolicated_share, node_count, command, recorded_at`;
const toProfile = (row: unknown) => mapRow<Profile>(row, {
	threads: (value: string) => JSON.parse(value) as Profile["threads"],
});

export function defaultHome(): string {
	if (process.env.BENCHBOARD_HOME) return path.resolve(process.env.BENCHBOARD_HOME);
	const data = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
	return path.join(data, "benchboard");
}

export function runId(date = new Date()): string {
	return `${date.toISOString().replace(/[-:.]/g, "")}-${randomBytes(4).toString("hex")}`;
}

/** Picks series keys: explicit keys win; otherwise one series per distinct command/label unless cases sweep commits. */
function caseKeys(cases: ExportedCase[], meta: IngestMetadata, commits: (string | null)[]): string[] {
	const explicit = meta.cases?.map((entry) => entry.case);
	const distinctCommits = new Set(commits).size === commits.length && commits.every((sha) => sha !== null);
	return cases.map((entry, index) => {
		if (explicit?.[index]) return explicit[index]!;
		if (entry.parameters && Object.keys(entry.parameters).length) {
			return slug(Object.entries(entry.parameters).map(([key, value]) => `${key}-${value}`).join("-"), "default", false);
		}
		if (cases.length === 1 || distinctCommits) return "default";
		return slug(meta.cases?.[index]?.name || entry.command, "default", false).slice(0, 80);
	});
}

export class Store {
	readonly home: string;
	readonly db: Database;

	constructor(home = defaultHome()) {
		this.home = home;
		this.db = openDatabase(home === ":memory:" ? ":memory:" : path.join(home, "benchboard.db"));
		const { failed } = this.reaggregateProfiles();
		for (const failure of failed) console.error(`benchboard: could not re-aggregate profile ${failure.id}: ${failure.error}`);
	}

	/** Incremented on every write; derived results are cached per version. */
	version = 0;
	private readonly derived = new Map<string, unknown>();
	private changed() {
		this.version++;
		this.derived.clear();
	}

	private dataVersion: number | null = null;

	/**
	 * Memoizes a value derived from the stored data until the next write, through this store or any
	 * other connection (another CLI process): SQLite's data_version changes when others commit.
	 */
	cached<T>(key: string, compute: () => T): T {
		const { data_version: current } = this.db.query("PRAGMA data_version").get() as { data_version: number };
		if (current !== this.dataVersion) {
			this.derived.clear();
			this.dataVersion = current;
		}
		if (this.derived.has(key)) return this.derived.get(key) as T;
		const value = compute();
		if (this.derived.size > 50_000) this.derived.clear();
		this.derived.set(key, value);
		return value;
	}

	close() {
		this.db.close();
	}

	private exportsDir() {
		return path.join(this.home, "exports");
	}

	exportPath(sha256: string): string {
		if (!/^[\da-f]{64}$/.test(sha256)) throw new Error("Invalid export digest.");
		return path.join(this.exportsDir(), `${sha256}.json`);
	}

	transaction<T>(body: () => T): T {
		this.db.run("BEGIN IMMEDIATE");
		try {
			const result = body();
			this.db.run("COMMIT");
			return result;
		} catch (error) {
			this.db.run("ROLLBACK");
			throw error;
		}
	}

	// ── Writes ────────────────────────────────────────────────────────────────

	upsertRepository(identity: RepositoryIdentity): Repository {
		this.db.query(`INSERT INTO repository (slug, name, remote_url, github_repo, local_path, created_at)
			VALUES (:slug, :name, :remote_url, :github_repo, :local_path, :created_at)
			ON CONFLICT (slug) DO UPDATE SET
				remote_url = coalesce(excluded.remote_url, remote_url),
				github_repo = coalesce(excluded.github_repo, github_repo),
				local_path = coalesce(excluded.local_path, local_path)`).run({
			slug: identity.slug, name: identity.name, remote_url: identity.remoteUrl, github_repo: identity.githubRepo,
			local_path: identity.root, created_at: new Date().toISOString(),
		});
		return this.repositoryBySlug(identity.slug)!;
	}

	upsertCommit(repositoryId: number, commit: CommitInfo) {
		this.db.query(`INSERT INTO git_commit (repository_id, sha, subject, author, authored_at, committed_at, parents)
			VALUES (:repository_id, :sha, :subject, :author, :authored_at, :committed_at, :parents)
			ON CONFLICT (repository_id, sha) DO UPDATE SET
				subject = coalesce(excluded.subject, subject), author = coalesce(excluded.author, author),
				authored_at = coalesce(excluded.authored_at, authored_at),
				committed_at = coalesce(excluded.committed_at, committed_at),
				parents = CASE WHEN excluded.parents = '[]' THEN parents ELSE excluded.parents END`).run({
			repository_id: repositoryId, sha: commit.sha, subject: commit.subject, author: commit.author,
			authored_at: commit.authoredAt, committed_at: commit.committedAt, parents: JSON.stringify(commit.parents),
		});
	}

	private upsertMachine(machine: MachineMetadata): number {
		const fingerprint = createHash("sha256")
			.update(JSON.stringify([machine.hostname, machine.os, machine.arch, machine.cpu, machine.ram])).digest("hex");
		this.db.query(`INSERT INTO machine (fingerprint, hostname, os, arch, cpu, ram)
			VALUES (:fingerprint, :hostname, :os, :arch, :cpu, :ram) ON CONFLICT (fingerprint) DO NOTHING`)
			.run({ fingerprint, ...machine });
		return (this.db.query("SELECT id FROM machine WHERE fingerprint = ?").get(fingerprint) as { id: number }).id;
	}

	private upsertBenchmark(repositoryId: number, key: string, title?: string, description?: string): Benchmark {
		this.db.query(`INSERT INTO benchmark (repository_id, key, title, description) VALUES (?, ?, ?, ?)
			ON CONFLICT (repository_id, key) DO UPDATE SET
				title = coalesce(title, excluded.title), description = coalesce(excluded.description, description)`)
			.run(repositoryId, key, title ?? null, description ?? null);
		return mapRow<Benchmark>(this.db.query("SELECT * FROM benchmark WHERE repository_id = ? AND key = ?").get(repositoryId, key));
	}

	/** Prepares (reads files, resolves commits in the checkout) and stores a run. */
	ingest(input: IngestInput & IngestOptions): IngestResult {
		return this.ingestPrepared(prepareRun(input), input);
	}

	/** Stores a prepared run. Reads nothing outside the data directory, so prepared runs may come from clients. */
	ingestPrepared(value: PreparedRun, options: IngestOptions = {}): IngestResult {
		const prepared = parsePreparedRun(value);
		const bytes = prepared.export;
		const cases = parseHyperfineExport(bytes);
		const meta = parseMetadata(prepared.metadata);
		if (meta.cases?.some((entry) => entry.profile !== undefined)) throw new Error("Prepared runs carry profiles separately, not as metadata paths.");
		if (meta.cases && meta.cases.length !== cases.length) {
			throw new Error(`Metadata describes ${meta.cases.length} cases but the export has ${cases.length}; keep them in export order.`);
		}
		if (prepared.cases.length !== cases.length) throw new Error(`The run attributes ${prepared.cases.length} cases but the export has ${cases.length}.`);
		if (prepared.profiles.some((profile) => profile.caseIndex >= cases.length)) throw new Error("A profile refers to a case outside the export.");
		if (meta.baseline !== undefined && meta.baseline > cases.length) throw new Error("Baseline is outside the exported cases.");
		const warnings = [...prepared.warnings];
		const sha256 = createHash("sha256").update(bytes).digest("hex");
		const duplicate = this.db.query("SELECT id FROM run WHERE export_sha256 = ? LIMIT 1").get(sha256) as { id: string } | undefined;
		if (duplicate && !options.allowDuplicate) {
			throw new Error(`This export was already ingested as run ${duplicate.id}; pass allowDuplicate to record it again.`);
		}
		const identity = options.remote ? { ...prepared.repository, root: null } : prepared.repository;
		const checkout = prepared.checkout;
		const commits = prepared.commits;
		const resolved = prepared.cases;
		const keys = caseKeys(cases, meta, resolved.map((entry) => entry.sha));
		const seen = new Map<string, number>();
		keys.forEach((key, index) => {
			const signature = `${key}\0${resolved[index].sha}\0${resolved[index].dirty}`;
			if (seen.has(signature)) {
				warnings.push(`Cases ${seen.get(signature)! + 1} and ${index + 1} share series "${key}" at the same revision; set distinct case keys if they measure different work.`);
			} else seen.set(signature, index);
		});
		const benchmarkKey = meta.benchmark ?? slug(meta.title ?? "default");
		const recordedAt = prepared.recordedAt ?? new Date().toISOString();
		const id = runId(new Date(recordedAt));
		const source = prepared.sourcePath;

		fs.mkdirSync(this.exportsDir(), { recursive: true, mode: 0o700 });
		const archived = this.exportPath(sha256);
		if (!fs.existsSync(archived)) {
			const temporary = `${archived}.${process.pid}.tmp`;
			fs.writeFileSync(temporary, bytes, { mode: 0o600 });
			fs.renameSync(temporary, archived);
		}

		return this.transaction(() => {
			const repository = this.upsertRepository(identity);
			for (const commit of commits) if (commit) this.upsertCommit(repository.id, commit);
			for (const entry of resolved) {
				if (entry.sha && !commits.some((commit) => commit?.sha === entry.sha)) {
					this.upsertCommit(repository.id, { sha: entry.sha, parents: [], subject: null, author: null, authoredAt: null, committedAt: null });
				}
			}
			const benchmark = this.upsertBenchmark(repository.id, benchmarkKey, meta.title, meta.description);
			const machineId = this.upsertMachine(prepared.machine);
			this.db.query(`INSERT INTO run (id, repository_id, machine_id, recorded_at, title, conditions, environment, invocation,
				warmup, notes, baseline_position, export_sha256, source_path, checkout_path, checkout_head, checkout_branch,
				checkout_dirty, legacy_id) VALUES (:id, :repository_id, :machine_id, :recorded_at, :title, :conditions,
				:environment, :invocation, :warmup, :notes, :baseline_position, :export_sha256, :source_path, :checkout_path,
				:checkout_head, :checkout_branch, :checkout_dirty, :legacy_id)`).run({
				id, repository_id: repository.id, machine_id: machineId, recorded_at: recordedAt, title: meta.title ?? null,
				conditions: meta.conditions ?? null, environment: meta.environment ?? null, invocation: meta.invocation ?? null,
				warmup: meta.warmup ?? null, notes: meta.notes ?? null, baseline_position: meta.baseline ?? null,
				export_sha256: sha256, source_path: source, checkout_path: checkout?.path ?? null, checkout_head: checkout?.head ?? null,
				checkout_branch: checkout?.branch ?? null, checkout_dirty: checkout?.dirty == null ? null : Number(checkout.dirty),
				legacy_id: prepared.legacyId ?? null,
			});
			const insert = this.db.query(`INSERT INTO measurement (run_id, position, benchmark_id, case_key, label, command,
				exported_command, commit_sha, dirty, commit_inferred, revision, build, notes, parameters, status, n, mean, stddev,
				median, min, max, q1, q3, p95, cv, user_time, system_time, rss_median, rss_peak, times, exit_codes)
				VALUES (:run_id, :position, :benchmark_id, :case_key, :label, :command, :exported_command, :commit_sha, :dirty,
				:commit_inferred, :revision, :build, :notes, :parameters, :status, :n, :mean, :stddev, :median, :min, :max, :q1,
				:q3, :p95, :cv, :user_time, :system_time, :rss_median, :rss_peak, :times, :exit_codes)`);
			cases.forEach((entry, index) => {
				const caseMeta = meta.cases?.[index];
				insert.run({
					run_id: id, position: index + 1, benchmark_id: benchmark.id, case_key: keys[index],
					label: caseMeta?.name || entry.command, command: caseMeta?.command ?? null, exported_command: entry.command,
					commit_sha: resolved[index].sha, dirty: resolved[index].dirty === null ? null : Number(resolved[index].dirty),
					commit_inferred: Number(resolved[index].inferred), revision: caseMeta?.revision ?? null,
					build: caseMeta?.build ?? meta.build ?? null, notes: caseMeta?.notes ?? null,
					parameters: entry.parameters ? JSON.stringify(entry.parameters) : null, status: entry.status,
					n: entry.n, mean: entry.mean, stddev: entry.stddev, median: entry.median, min: entry.min, max: entry.max,
					q1: entry.q1, q3: entry.q3, p95: entry.p95, cv: entry.cv, user_time: entry.user, system_time: entry.system,
					rss_median: entry.rssMedian, rss_peak: entry.rssPeak, times: JSON.stringify(entry.times),
					exit_codes: entry.exitCodes ? JSON.stringify(entry.exitCodes) : null,
				});
			});
			const measurements = this.runMeasurements(id);
			for (const { caseIndex, ...profile } of prepared.profiles) this.attachPreparedProfile(measurements[caseIndex].id, profile);
			this.changed();
			return { run: this.run(id)!, measurements, benchmark, repository, warnings };
		});
	}

	/** Reads a profile (and its symbol sidecar) from disk and attaches it to a measurement. */
	attachProfile(input: AttachProfileInput): Profile {
		return this.attachPreparedProfile(input.measurementId, prepareProfile(input));
	}

	/** Stores a sampled profile for a measurement: raw files content-addressed, plus an aggregated call tree. */
	attachPreparedProfile(measurementId: number, value: PreparedProfile): Profile {
		const input = parsePreparedProfile(value);
		const measurement = this.measurement(measurementId);
		if (!measurement) throw new Error(`Unknown measurement ${measurementId}.`);
		const { bytes, syms: symsBytes } = input;
		const parsed = this.parseProfileFiles(bytes, symsBytes, input.symsName);
		const digest = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
		const sha256 = digest(bytes);
		const symsSha256 = symsBytes ? digest(symsBytes) : null;
		const store = (name: string, data: Uint8Array) => {
			const target = path.join(this.home, "profiles", name);
			if (fs.existsSync(target)) return;
			fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
			fs.writeFileSync(`${target}.${process.pid}.tmp`, data, { mode: 0o600 });
			fs.renameSync(`${target}.${process.pid}.tmp`, target);
		};
		// Raw profiles are kept gzip-compressed; the Firefox Profiler accepts either form.
		store(`${sha256}.json.gz`, bytes[0] === 0x1f && bytes[1] === 0x8b ? bytes : Bun.gzipSync(new Uint8Array(bytes)));
		if (symsBytes && symsSha256) store(`${symsSha256}.syms.json`, symsBytes);
		const id = Number(this.db.query(`INSERT INTO profile (measurement_id, label, tool, sha256, syms_sha256, product, iterations,
			samples, interval_ms, duration_ms, threads, symbolicated_share, node_count, command, recorded_at, tree, cpu_ms, sampled_ms,
			cpu_source, tree_version)
			VALUES (:measurement_id, :label, 'samply', :sha256, :syms_sha256, :product, :iterations, :samples, :interval_ms,
			:duration_ms, :threads, :symbolicated_share, :node_count, :command, :recorded_at, :tree, :cpu_ms, :sampled_ms,
			:cpu_source, :tree_version)`).run({
			measurement_id: measurement.id, label: input.label ?? null, sha256, syms_sha256: symsSha256, product: parsed.product,
			iterations: input.iterations ?? 1, command: input.command ?? null, recorded_at: new Date().toISOString(),
			...this.profileColumns(parsed),
		}).lastInsertRowid);
		this.changed();
		return this.profile(id)!;
	}

	private parseProfileFiles(bytes: Uint8Array, symsBytes: Uint8Array | null, symsName: string | null) {
		let syms: SymsSidecar | null = null;
		if (symsBytes) {
			try { syms = JSON.parse(new TextDecoder().decode(symsBytes)); } catch (error) { throw new Error(`Invalid symbol sidecar ${symsName}: ${(error as Error).message}`); }
		}
		return parseProfile(decodeProfileBytes(bytes), syms);
	}

	private profileColumns(parsed: ReturnType<typeof parseProfile>) {
		return {
			samples: parsed.tree.samples, interval_ms: parsed.tree.intervalMs, duration_ms: parsed.durationMs,
			threads: JSON.stringify(parsed.tree.threads), symbolicated_share: parsed.symbolicatedShare,
			node_count: parsed.tree.nodes.func.length, cpu_ms: parsed.tree.cpuMs, sampled_ms: parsed.tree.sampledMs,
			cpu_source: parsed.tree.cpuSource, tree_version: TREE_VERSION,
			tree: Bun.gzipSync(new TextEncoder().encode(JSON.stringify(parsed.tree))),
		};
	}

	/** Rebuilds call trees aggregated by an older parser from the retained raw profiles. */
	reaggregateProfiles(): { updated: number; failed: { id: number; error: string }[] } {
		const outdated = this.db.query("SELECT id, sha256, syms_sha256 FROM profile WHERE tree_version < ?").all(TREE_VERSION) as
			{ id: number; sha256: string; syms_sha256: string | null }[];
		const failed: { id: number; error: string }[] = [];
		const update = this.db.query(`UPDATE profile SET samples = :samples, interval_ms = :interval_ms, duration_ms = :duration_ms,
			threads = :threads, symbolicated_share = :symbolicated_share, node_count = :node_count, cpu_ms = :cpu_ms,
			sampled_ms = :sampled_ms, cpu_source = :cpu_source, tree_version = :tree_version, tree = :tree WHERE id = :id`);
		for (const row of outdated) {
			try {
				const raw = fs.readFileSync(path.join(this.home, "profiles", `${row.sha256}.json.gz`));
				const symsName = row.syms_sha256 ? path.join(this.home, "profiles", `${row.syms_sha256}.syms.json`) : null;
				const syms = symsName && fs.existsSync(symsName) ? fs.readFileSync(symsName) : null;
				update.run({ id: row.id, ...this.profileColumns(this.parseProfileFiles(raw, syms, symsName)) });
			} catch (error) {
				failed.push({ id: row.id, error: (error as Error).message });
			}
		}
		if (outdated.length) this.changed();
		return { updated: outdated.length - failed.length, failed };
	}

	profile(id: number): Profile | undefined {
		const row = this.db.query(`SELECT ${PROFILE_COLUMNS} FROM profile WHERE id = ?`).get(id);
		return row ? toProfile(row) : undefined;
	}
	profilesForMeasurement(measurementId: number): Profile[] {
		return this.db.query(`SELECT ${PROFILE_COLUMNS} FROM profile WHERE measurement_id = ? ORDER BY id`).all(measurementId).map(toProfile);
	}
	/** Profiles for many measurements in one query, grouped by measurement. */
	profilesForMeasurements(measurementIds: number[]): Map<number, Profile[]> {
		const result = new Map<number, Profile[]>(measurementIds.map((id) => [id, []]));
		if (!measurementIds.length) return result;
		for (const profile of this.db.query(`SELECT ${PROFILE_COLUMNS} FROM profile WHERE measurement_id IN (SELECT value FROM json_each(?)) ORDER BY id`)
			.all(JSON.stringify(measurementIds)).map(toProfile)) {
			result.get(profile.measurementId)?.push(profile);
		}
		return result;
	}
	/** Profiles of the same benchmark case (any commit or run), newest first. */
	profilesForSeries(benchmarkId: number, caseKey: string, limit = 100): Profile[] {
		return this.db.query(`SELECT ${PROFILE_COLUMNS.replace(/(^|,\s*)(\w)/g, "$1p.$2")} FROM profile p
			JOIN measurement m ON m.id = p.measurement_id JOIN run r ON r.id = m.run_id
			WHERE m.benchmark_id = ? AND m.case_key = ? ORDER BY r.recorded_at DESC, p.id DESC LIMIT ?`)
			.all(benchmarkId, caseKey, limit).map(toProfile);
	}
	private profileFilter(repositoryId: number, search?: string): { where: string; params: Record<string, string | number | null> } {
		const params: Record<string, string | number | null> = { repository: repositoryId };
		let where = "WHERE r.repository_id = :repository";
		const text = search?.trim().toLowerCase();
		if (text) {
			params.like = `%${text.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
			params.prefix = `${text.replace(/[^0-9a-f]/g, "")}%`;
			where += ` AND (lower(b.key) LIKE :like ESCAPE '\\' OR lower(m.case_key) LIKE :like ESCAPE '\\'
				OR lower(coalesce(p.label, '')) LIKE :like ESCAPE '\\' OR lower(coalesce(r.title, '')) LIKE :like ESCAPE '\\'
				OR (length(:prefix) > 4 AND m.commit_sha LIKE :prefix) OR CAST(p.id AS TEXT) = :exact)`;
			params.exact = text;
		}
		return { where, params };
	}

	profilesForRepository(repositoryId: number, options: { limit?: number; offset?: number; search?: string } | number = {}): Profile[] {
		const query = typeof options === "number" ? { limit: options } : options;
		const { where, params } = this.profileFilter(repositoryId, query.search);
		return this.db.query(`SELECT ${PROFILE_COLUMNS.replace(/(^|,\s*)(\w)/g, "$1p.$2")} FROM profile p
			JOIN measurement m ON m.id = p.measurement_id JOIN run r ON r.id = m.run_id JOIN benchmark b ON b.id = m.benchmark_id
			${where} ORDER BY p.recorded_at DESC, p.id DESC LIMIT :limit OFFSET :offset`)
			.all({ ...params, limit: Math.min(Math.max(query.limit ?? 100, 1), 1000), offset: Math.max(0, query.offset ?? 0) }).map(toProfile);
	}
	profileCount(repositoryId: number, search?: string): number {
		const { where, params } = this.profileFilter(repositoryId, search);
		return (this.db.query(`SELECT count(*) AS n FROM profile p JOIN measurement m ON m.id = p.measurement_id
			JOIN run r ON r.id = m.run_id JOIN benchmark b ON b.id = m.benchmark_id ${where}`).get(params) as { n: number }).n;
	}
	/** Decompressed call tree, cached until the stored data changes (trees can be several MB). */
	profileTree(id: number): CallTree {
		return this.cached(`tree:${id}`, () => {
			const row = this.db.query("SELECT tree FROM profile WHERE id = ?").get(id) as { tree: Uint8Array } | null;
			if (!row) throw new Error(`Unknown profile ${id}.`);
			return JSON.parse(new TextDecoder().decode(Bun.gunzipSync(row.tree as Uint8Array<ArrayBuffer>))) as CallTree;
		});
	}
	profileFile(profile: Profile): string {
		return path.join(this.home, "profiles", `${profile.sha256}.json.gz`);
	}
	profileSymsFile(profile: Profile): string | null {
		return profile.symsSha256 ? path.join(this.home, "profiles", `${profile.symsSha256}.syms.json`) : null;
	}
	deleteProfile(id: number): boolean {
		this.changed();
		return this.db.query("DELETE FROM profile WHERE id = ?").run(id).changes > 0;
	}
	/** Resolves `run-id[:position]` (position defaults to the only case). */
	measurementByReference(reference: string): Measurement {
		const [runId, position] = reference.split(":");
		const measurements = this.runMeasurements(runId);
		if (!measurements.length) throw new Error(`Unknown run ${runId}.`);
		if (position === undefined) {
			if (measurements.length > 1) throw new Error(`Run ${runId} has ${measurements.length} cases; use ${runId}:<position>.`);
			return measurements[0];
		}
		const found = measurements.find((measurement) => measurement.position === Number(position));
		if (!found) throw new Error(`Run ${runId} has no case ${position}.`);
		return found;
	}

	/** Synchronizes a GitHub pull request's commits; `reference` is `123`, `owner/name#123` or a URL. */
	/** Fetches a GitHub pull request (via the REST API) and stores it with its commits. */
	async syncGithubPullRequest(options: { cwd?: string; repositoryId?: number; reference: string | number }): Promise<PullRequest> {
		const reference = parsePullRequestReference(String(options.reference));
		const known = options.repositoryId === undefined ? undefined : this.repository(options.repositoryId);
		const cwd = options.cwd ?? (known?.localPath && fs.existsSync(known.localPath) ? known.localPath : undefined);
		const snapshot = await snapshotGithubPullRequest({
			number: reference.number,
			candidates: reference.githubRepo ? [reference.githubRepo]
				: [...new Set([...(cwd ? githubRemotes(cwd) : []), ...(known?.githubRepo ? [known.githubRepo] : [])])],
			repository: cwd ? repositoryIdentity(cwd) : null,
			resolveLocal: cwd ? (sha) => resolveCommit(cwd, sha) : undefined,
		});
		return this.savePullRequest(snapshot, { repositoryId: known?.id });
	}

	/** Tracks a local branch like a pull request: commits in `base..head`, oldest first. */
	syncLocalBranch(options: { cwd: string; head?: string; base?: string; title?: string }): PullRequest {
		return this.savePullRequest(snapshotLocalBranch(options));
	}

	/**
	 * Stores a pull request snapshot (possibly from a client). The repository is the snapshot's checkout
	 * identity, else `repositoryId`, else the repository known for the GitHub repo, else a new one.
	 */
	savePullRequest(value: PullRequestSnapshot, options: { repositoryId?: number; remote?: boolean } = {}): PullRequest {
		const snapshot = parsePullRequestSnapshot(value);
		const pr = snapshot.pullRequest;
		return this.transaction(() => {
			const identity = snapshot.repository && (options.remote ? { ...snapshot.repository, root: null } : snapshot.repository);
			const known = options.repositoryId === undefined ? undefined : this.repository(options.repositoryId);
			const repository = identity ? this.upsertRepository(identity) : known
				?? (pr.githubRepo ? this.repositoryByGithub(pr.githubRepo) : undefined)
				?? this.upsertRepository(pr.githubRepo
					? { slug: `github.com/${pr.githubRepo}`, name: pr.githubRepo.split("/")[1], remoteUrl: null, githubRepo: pr.githubRepo, root: null }
					: (() => { throw new Error("A local branch snapshot needs its repository identity."); })());
			return this.storePullRequest(repository.id, pr, snapshot.base, snapshot.commits);
		});
	}

	async resyncPullRequest(id: number): Promise<PullRequest> {
		const pr = this.pullRequest(id);
		if (!pr) throw new Error(`Unknown pull request ${id}.`);
		if (pr.source === "github") {
			return this.syncGithubPullRequest({ repositoryId: pr.repositoryId, reference: `${pr.githubRepo}#${pr.number}` });
		}
		const repository = this.repository(pr.repositoryId)!;
		if (!repository.localPath || !fs.existsSync(repository.localPath)) {
			throw new Error(`Local branches are synced from a checkout: run \`benchboard pr sync ${pr.headRef}\` in one.`);
		}
		return this.syncLocalBranch({ cwd: repository.localPath, head: pr.headRef, base: pr.baseRef, title: pr.title });
	}

	private storePullRequest(
		repositoryId: number, pr: Omit<PullRequest, "id" | "repositoryId" | "syncedAt">, base: CommitInfo | null, commits: CommitInfo[],
	): PullRequest {
		const values = {
			repository_id: repositoryId, source: pr.source, github_repo: pr.githubRepo, number: pr.number, title: pr.title,
			url: pr.url, state: pr.state, author: pr.author, head_ref: pr.headRef, head_sha: pr.headSha, base_ref: pr.baseRef,
			base_sha: pr.baseSha, updated_at: pr.updatedAt, synced_at: new Date().toISOString(),
		};
		const existing = (pr.source === "github"
			? this.db.query("SELECT id FROM pull_request WHERE source = 'github' AND github_repo = ? AND number = ?").get(pr.githubRepo, pr.number)
			: this.db.query("SELECT id FROM pull_request WHERE source = 'local' AND repository_id = ? AND head_ref = ?").get(repositoryId, pr.headRef)) as { id: number } | undefined;
		let id: number;
		if (existing) {
			id = existing.id;
			this.db.query(`UPDATE pull_request SET repository_id = :repository_id, title = :title, url = :url, state = :state,
				author = :author, head_sha = :head_sha, base_ref = :base_ref, base_sha = :base_sha, updated_at = :updated_at,
				synced_at = :synced_at WHERE id = :id`).run({
				id, repository_id: values.repository_id, title: values.title, url: values.url, state: values.state, author: values.author,
				head_sha: values.head_sha, base_ref: values.base_ref, base_sha: values.base_sha, updated_at: values.updated_at,
				synced_at: values.synced_at,
			});
		} else {
			id = Number(this.db.query(`INSERT INTO pull_request (repository_id, source, github_repo, number, title, url, state,
				author, head_ref, head_sha, base_ref, base_sha, updated_at, synced_at) VALUES (:repository_id, :source, :github_repo,
				:number, :title, :url, :state, :author, :head_ref, :head_sha, :base_ref, :base_sha, :updated_at, :synced_at)`)
				.run(values).lastInsertRowid);
		}
		if (base) this.upsertCommit(repositoryId, base);
		this.db.query("DELETE FROM pull_request_commit WHERE pull_request_id = ?").run(id);
		const insert = this.db.query("INSERT INTO pull_request_commit (pull_request_id, position, sha) VALUES (?, ?, ?)");
		commits.forEach((commit, index) => {
			this.upsertCommit(repositoryId, commit);
			insert.run(id, index + 1, commit.sha);
		});
		this.changed();
		return this.pullRequest(id)!;
	}

	/** Runs imported from pi /bench, by their original ID. */
	legacyIds(): string[] {
		return (this.db.query("SELECT legacy_id FROM run WHERE legacy_id IS NOT NULL").all() as { legacy_id: string }[]).map((row) => row.legacy_id);
	}

	deleteRun(id: string): boolean {
		this.changed();
		return this.db.query("DELETE FROM run WHERE id = ?").run(id).changes > 0;
	}

	// ── Reads ─────────────────────────────────────────────────────────────────

	repositories(): Repository[] {
		return this.db.query("SELECT * FROM repository ORDER BY name, slug").all().map((row) => mapRow<Repository>(row));
	}
	repository(id: number): Repository | undefined {
		const row = this.db.query("SELECT * FROM repository WHERE id = ?").get(id);
		return row ? mapRow<Repository>(row) : undefined;
	}
	repositoryBySlug(slugValue: string): Repository | undefined {
		const row = this.db.query("SELECT * FROM repository WHERE slug = ?").get(slugValue);
		return row ? mapRow<Repository>(row) : undefined;
	}
	repositoryByGithub(githubRepo: string): Repository | undefined {
		const row = this.db.query("SELECT * FROM repository WHERE github_repo = ? OR slug = ? LIMIT 1").get(githubRepo, `github.com/${githubRepo}`);
		return row ? mapRow<Repository>(row) : undefined;
	}
	/** The repository a checkout belongs to, if it has been recorded. */
	repositoryForCheckout(cwd: string): Repository | undefined {
		return this.repositoryBySlug(repositoryIdentity(cwd).slug);
	}

	commit(repositoryId: number, sha: string): Commit | undefined {
		const row = this.db.query("SELECT * FROM git_commit WHERE repository_id = ? AND sha = ?").get(repositoryId, sha);
		return row ? toCommit(row) : undefined;
	}
	commitsByPrefix(repositoryId: number, prefix: string): Commit[] {
		return this.db.query("SELECT * FROM git_commit WHERE repository_id = ? AND sha LIKE ? || '%' LIMIT 10")
			.all(repositoryId, prefix.toLowerCase().replace(/[^0-9a-f]/g, "")).map(toCommit);
	}

	pullRequests(repositoryId?: number): PullRequest[] {
		const rows = repositoryId === undefined
			? this.db.query("SELECT * FROM pull_request ORDER BY coalesce(updated_at, synced_at) DESC").all()
			: this.db.query("SELECT * FROM pull_request WHERE repository_id = ? ORDER BY coalesce(updated_at, synced_at) DESC").all(repositoryId);
		return rows.map((row) => mapRow<PullRequest>(row));
	}
	pullRequest(id: number): PullRequest | undefined {
		const row = this.db.query("SELECT * FROM pull_request WHERE id = ?").get(id);
		return row ? mapRow<PullRequest>(row) : undefined;
	}
	findPullRequest(repositoryId: number, reference: string): PullRequest | undefined {
		const numeric = /^#?(\d+)$/.exec(reference);
		const row = numeric
			? this.db.query("SELECT * FROM pull_request WHERE repository_id = ? AND number = ? ORDER BY synced_at DESC LIMIT 1").get(repositoryId, Number(numeric[1]))
			: this.db.query("SELECT * FROM pull_request WHERE repository_id = ? AND head_ref = ? ORDER BY synced_at DESC LIMIT 1").get(repositoryId, reference);
		return row ? mapRow<PullRequest>(row) : undefined;
	}
	/** Ordered PR commits, excluding the base. */
	pullRequestCommits(id: number): Commit[] {
		return this.db.query(`SELECT c.* FROM pull_request_commit p
			JOIN pull_request pr ON pr.id = p.pull_request_id
			JOIN git_commit c ON c.repository_id = pr.repository_id AND c.sha = p.sha
			WHERE p.pull_request_id = ? ORDER BY p.position`).all(id).map(toCommit);
	}
	pullRequestsForCommit(repositoryId: number, sha: string): PullRequest[] {
		return this.db.query(`SELECT DISTINCT pr.* FROM pull_request pr LEFT JOIN pull_request_commit p ON p.pull_request_id = pr.id
			WHERE pr.repository_id = ? AND (p.sha = ? OR pr.base_sha = ?) ORDER BY pr.synced_at DESC`)
			.all(repositoryId, sha, sha).map((row) => mapRow<PullRequest>(row));
	}

	/** Where a commit sits in each tracked PR: 0 for the base, 1… for PR commits. */
	commitPositions(repositoryId: number, sha: string): { pullRequest: PullRequest; position: number }[] {
		return this.pullRequestsForCommit(repositoryId, sha).map((pullRequest) => {
			if (pullRequest.baseSha === sha) return { pullRequest, position: 0 };
			const row = this.db.query("SELECT position FROM pull_request_commit WHERE pull_request_id = ? AND sha = ?").get(pullRequest.id, sha) as { position: number } | null;
			return { pullRequest, position: row?.position ?? -1 };
		});
	}

	benchmarks(repositoryId: number): Benchmark[] {
		return this.db.query("SELECT * FROM benchmark WHERE repository_id = ? ORDER BY key").all(repositoryId).map((row) => mapRow<Benchmark>(row));
	}
	benchmark(id: number): Benchmark | undefined {
		const row = this.db.query("SELECT * FROM benchmark WHERE id = ?").get(id);
		return row ? mapRow<Benchmark>(row) : undefined;
	}
	benchmarkByKey(repositoryId: number, key: string): Benchmark | undefined {
		const row = this.db.query("SELECT * FROM benchmark WHERE repository_id = ? AND key = ?").get(repositoryId, key);
		return row ? mapRow<Benchmark>(row) : undefined;
	}
	benchmarkCases(benchmarkId: number): { caseKey: string; count: number; lastRecordedAt: string }[] {
		return this.db.query(`SELECT m.case_key, count(*) AS count, max(r.recorded_at) AS last_recorded_at
			FROM measurement m JOIN run r ON r.id = m.run_id WHERE m.benchmark_id = ? GROUP BY m.case_key ORDER BY m.case_key`)
			.all(benchmarkId).map((row) => mapRow(row));
	}

	/** Case summaries for every benchmark of a repository in one query. */
	benchmarkCasesForRepository(repositoryId: number): Map<number, { caseKey: string; count: number; lastRecordedAt: string }[]> {
		const result = new Map<number, { caseKey: string; count: number; lastRecordedAt: string }[]>();
		for (const row of this.db.query(`SELECT m.benchmark_id, m.case_key, count(*) AS count, max(r.recorded_at) AS last_recorded_at
			FROM measurement m JOIN run r ON r.id = m.run_id WHERE r.repository_id = ? GROUP BY m.benchmark_id, m.case_key
			ORDER BY m.benchmark_id, m.case_key`).all(repositoryId) as { benchmark_id: number; case_key: string; count: number; last_recorded_at: string }[]) {
			const list = result.get(row.benchmark_id) ?? [];
			list.push({ caseKey: row.case_key, count: row.count, lastRecordedAt: row.last_recorded_at });
			result.set(row.benchmark_id, list);
		}
		return result;
	}

	/** The latest `limit` measurements of every series of a repository (chronological), in one query. */
	recentSeriesMeasurements(repositoryId: number, limit: number): Map<string, Measurement[]> {
		const result = new Map<string, Measurement[]>();
		const rows = this.db.query(`SELECT * FROM (
				SELECT ${MEASUREMENT_COLUMNS}, row_number() OVER (PARTITION BY m.benchmark_id, m.case_key ORDER BY r.recorded_at DESC, m.position) AS rank
				FROM measurement m JOIN run r ON r.id = m.run_id WHERE r.repository_id = ?)
			WHERE rank <= ? ORDER BY recorded_at, position`).all(repositoryId, limit) as Record<string, unknown>[];
		for (const row of rows) {
			delete row.rank;
			const measurement = toMeasurement(row);
			const key = `${measurement.benchmarkId}\0${measurement.caseKey}`;
			result.set(key, [...result.get(key) ?? [], measurement]);
		}
		return result;
	}

	/** Machines by ID in one query. */
	machines(ids: number[]): Map<number, Machine> {
		return new Map(this.db.query("SELECT * FROM machine WHERE id IN (SELECT value FROM json_each(?))").all(JSON.stringify(ids))
			.map((row) => { const machine = mapRow<Machine>(row); return [machine.id, machine] as const; }));
	}

	machine(id: number): Machine | undefined {
		const row = this.db.query("SELECT * FROM machine WHERE id = ?").get(id);
		return row ? mapRow<Machine>(row) : undefined;
	}

	/** WHERE clause and named parameters shared by run listing and counting. */
	private runFilter(options: RunQuery): { where: string; params: Record<string, string | number | null> } {
		const where: string[] = [];
		const params: Record<string, string | number | null> = {};
		if (options.repositoryId !== undefined) { where.push("r.repository_id = :repository"); params.repository = options.repositoryId; }
		if (options.benchmarkId !== undefined) {
			where.push("EXISTS (SELECT 1 FROM measurement m WHERE m.run_id = r.id AND m.benchmark_id = :benchmark)");
			params.benchmark = options.benchmarkId;
		}
		const search = options.search?.trim().toLowerCase();
		if (search) {
			// Run ID or title, a measured commit SHA prefix, or a benchmark key, case key or case label.
			params.like = `%${search.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
			params.prefix = `${search.replace(/[^0-9a-f]/g, "")}%`;
			where.push(`(lower(r.id) LIKE :like ESCAPE '\\' OR lower(coalesce(r.title, '')) LIKE :like ESCAPE '\\' OR EXISTS (
				SELECT 1 FROM measurement m JOIN benchmark b ON b.id = m.benchmark_id WHERE m.run_id = r.id AND (
					(length(:prefix) > 4 AND m.commit_sha LIKE :prefix) OR lower(b.key) LIKE :like ESCAPE '\\'
					OR lower(m.case_key) LIKE :like ESCAPE '\\' OR lower(m.label) LIKE :like ESCAPE '\\')))`);
		}
		return { where: where.length ? `WHERE ${where.join(" AND ")}` : "", params };
	}

	runs(options: RunQuery = {}): Run[] {
		const { where, params } = this.runFilter(options);
		return this.db.query(`SELECT r.* FROM run r ${where} ORDER BY r.recorded_at DESC, r.id DESC LIMIT :limit OFFSET :offset`)
			.all({ ...params, limit: Math.min(Math.max(options.limit ?? 50, 1), 500), offset: Math.max(0, options.offset ?? 0) }).map(toRun);
	}
	runCount(options: RunQuery | number = {}): number {
		const { where, params } = this.runFilter(typeof options === "number" ? { repositoryId: options } : options);
		return (this.db.query(`SELECT count(*) AS n FROM run r ${where}`).get(params) as { n: number }).n;
	}
	run(id: string): Run | undefined {
		const row = this.db.query("SELECT * FROM run WHERE id = ?").get(id);
		return row ? toRun(row) : undefined;
	}
	runMeasurements(runId: string): Measurement[] {
		return this.db.query(`SELECT ${MEASUREMENT_COLUMNS} FROM measurement m JOIN run r ON r.id = m.run_id
			WHERE m.run_id = ? ORDER BY m.position`).all(runId).map(toMeasurement);
	}
	/** Measurements of many runs in one query, grouped by run (in case order). */
	measurementsForRuns(runIds: string[]): Map<string, Measurement[]> {
		const result = new Map<string, Measurement[]>(runIds.map((id) => [id, []]));
		if (!runIds.length) return result;
		for (const measurement of this.db.query(`SELECT ${MEASUREMENT_COLUMNS} FROM measurement m JOIN run r ON r.id = m.run_id
			WHERE m.run_id IN (SELECT value FROM json_each(?)) ORDER BY m.run_id, m.position`).all(JSON.stringify(runIds)).map(toMeasurement)) {
			result.get(measurement.runId)?.push(measurement);
		}
		return result;
	}
	measurement(id: number): Measurement | undefined {
		const row = this.db.query(`SELECT ${MEASUREMENT_COLUMNS} FROM measurement m JOIN run r ON r.id = m.run_id WHERE m.id = ?`).get(id);
		return row ? toMeasurement(row) : undefined;
	}
	measurementsForCommits(repositoryId: number, shas: string[]): Measurement[] {
		if (!shas.length) return [];
		return this.db.query(`SELECT ${MEASUREMENT_COLUMNS} FROM measurement m JOIN run r ON r.id = m.run_id
			WHERE r.repository_id = ? AND m.commit_sha IN (SELECT value FROM json_each(?))
			ORDER BY r.recorded_at, m.position`).all(repositoryId, JSON.stringify(shas)).map(toMeasurement);
	}
	seriesMeasurements(benchmarkId: number, caseKey?: string, limit = 1000): Measurement[] {
		const rows = caseKey === undefined
			? this.db.query(`SELECT ${MEASUREMENT_COLUMNS} FROM measurement m JOIN run r ON r.id = m.run_id
				WHERE m.benchmark_id = ? ORDER BY r.recorded_at DESC, m.position LIMIT ?`).all(benchmarkId, limit)
			: this.db.query(`SELECT ${MEASUREMENT_COLUMNS} FROM measurement m JOIN run r ON r.id = m.run_id
				WHERE m.benchmark_id = ? AND m.case_key = ? ORDER BY r.recorded_at DESC, m.position LIMIT ?`).all(benchmarkId, caseKey, limit);
		return rows.map(toMeasurement).reverse();
	}

	times(measurementId: number): number[] {
		const row = this.db.query("SELECT times FROM measurement WHERE id = ?").get(measurementId) as { times: string } | undefined;
		return row ? JSON.parse(row.times) : [];
	}
	exitCodes(measurementId: number): number[] | null {
		const row = this.db.query("SELECT exit_codes FROM measurement WHERE id = ?").get(measurementId) as { exit_codes: string | null } | undefined;
		return row?.exit_codes ? JSON.parse(row.exit_codes) : null;
	}
}
