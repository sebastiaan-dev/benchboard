import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { openDatabase } from "./db.ts";
import { parseHyperfineExport, MAX_EXPORT_BYTES, type ExportedCase, type CaseStatus } from "./hyperfine.ts";
import { parseMetadata, slug, type IngestMetadata, type MachineMetadata } from "./metadata.ts";
import {
	FULL_SHA, commitRange, githubRemotes, mergeBase, repositoryIdentity, resolveCommit, workingTree,
	type CommitInfo, type RepositoryIdentity,
} from "./git.ts";
import { fetchCommit, fetchPullRequest, parsePullRequestReference } from "./github.ts";

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

export interface IngestInput {
	/** Hyperfine export path, resolved against cwd. */
	file: string;
	/** Checkout used to resolve repository identity and revisions. */
	cwd: string;
	metadata?: unknown;
	allowDuplicate?: boolean;
	/** Overrides for importers; not part of the public metadata contract. */
	internal?: {
		recordedAt?: string;
		legacyId?: string;
		inferredCommits?: { sha: string | null; dirty: boolean | null }[];
		repository?: RepositoryIdentity;
		/** Checkout state at measurement time, when it differs from the importing checkout. */
		checkout?: { path: string | null; head: string | null; branch: string | null; dirty: boolean | null };
	};
}
export interface IngestResult {
	run: Run;
	measurements: Measurement[];
	benchmark: Benchmark;
	repository: Repository;
	warnings: string[];
}

type Row = Record<string, SQLInputValue>;

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

export function defaultHome(): string {
	if (process.env.BENCHBOARD_HOME) return path.resolve(process.env.BENCHBOARD_HOME);
	const data = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
	return path.join(data, "benchboard");
}

function readBounded(file: string): Buffer {
	const fd = fs.openSync(file, "r");
	try {
		const stat = fs.fstatSync(fd);
		if (!stat.isFile() || stat.size > MAX_EXPORT_BYTES) throw new Error(`Expected a regular file of at most ${MAX_EXPORT_BYTES / 1024 / 1024} MiB: ${file}`);
		const bytes = Buffer.alloc(stat.size);
		let length = 0;
		while (length < bytes.length) {
			const read = fs.readSync(fd, bytes, length, bytes.length - length, length);
			if (!read) break;
			length += read;
		}
		if (length !== stat.size) throw new Error("Export changed while being read; retry after Hyperfine finishes.");
		return bytes;
	} finally {
		fs.closeSync(fd);
	}
}

function localMachine(): MachineMetadata {
	return {
		hostname: os.hostname(), os: `${os.platform()} ${os.release()}`, arch: os.arch(),
		cpu: os.cpus()[0]?.model ?? "Unknown", ram: os.totalmem(),
	};
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
	readonly db: DatabaseSync;

	constructor(home = defaultHome()) {
		this.home = home;
		this.db = openDatabase(home === ":memory:" ? ":memory:" : path.join(home, "benchboard.db"));
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
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const result = body();
			this.db.exec("COMMIT");
			return result;
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}

	// ── Writes ────────────────────────────────────────────────────────────────

	upsertRepository(identity: RepositoryIdentity): Repository {
		this.db.prepare(`INSERT INTO repository (slug, name, remote_url, github_repo, local_path, created_at)
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
		this.db.prepare(`INSERT INTO git_commit (repository_id, sha, subject, author, authored_at, committed_at, parents)
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
		this.db.prepare(`INSERT INTO machine (fingerprint, hostname, os, arch, cpu, ram)
			VALUES (:fingerprint, :hostname, :os, :arch, :cpu, :ram) ON CONFLICT (fingerprint) DO NOTHING`)
			.run({ fingerprint, ...machine });
		return (this.db.prepare("SELECT id FROM machine WHERE fingerprint = ?").get(fingerprint) as { id: number }).id;
	}

	private upsertBenchmark(repositoryId: number, key: string, title?: string, description?: string): Benchmark {
		this.db.prepare(`INSERT INTO benchmark (repository_id, key, title, description) VALUES (?, ?, ?, ?)
			ON CONFLICT (repository_id, key) DO UPDATE SET
				title = coalesce(title, excluded.title), description = coalesce(excluded.description, description)`)
			.run(repositoryId, key, title ?? null, description ?? null);
		return mapRow<Benchmark>(this.db.prepare("SELECT * FROM benchmark WHERE repository_id = ? AND key = ?").get(repositoryId, key));
	}

	ingest(input: IngestInput): IngestResult {
		const source = path.resolve(input.cwd, input.file.startsWith("~/") ? path.join(os.homedir(), input.file.slice(2)) : input.file);
		const bytes = readBounded(source);
		const cases = parseHyperfineExport(bytes);
		const meta = parseMetadata(input.metadata);
		const warnings: string[] = [];
		if (meta.cases && meta.cases.length !== cases.length) {
			throw new Error(`Metadata describes ${meta.cases.length} cases but the export has ${cases.length}; keep them in export order.`);
		}
		if (meta.baseline !== undefined && meta.baseline > cases.length) throw new Error("Baseline is outside the exported cases.");
		const sha256 = createHash("sha256").update(bytes).digest("hex");
		const duplicate = this.db.prepare("SELECT id FROM run WHERE export_sha256 = ? LIMIT 1").get(sha256) as { id: string } | undefined;
		if (duplicate && !input.allowDuplicate) {
			throw new Error(`This export was already ingested as run ${duplicate.id}; pass allowDuplicate to record it again.`);
		}

		const identity = input.internal?.repository ?? repositoryIdentity(input.cwd);
		const root = identity.root;
		// Importers that supply the historical checkout state skip the (slow, in large trees) live inspection.
		const tree = root && input.internal?.checkout === undefined ? workingTree(input.cwd) : null;
		const checkout = input.internal?.checkout !== undefined ? input.internal.checkout
			: tree && { path: tree.root, head: tree.head, branch: tree.branch, dirty: tree.dirty() };
		const commits: (CommitInfo | null)[] = [];
		const resolved = cases.map((_, index) => {
			const inferred = input.internal?.inferredCommits?.[index];
			if (inferred) {
				const info = inferred.sha && root ? resolveCommit(root, inferred.sha) : null;
				commits.push(info);
				return { sha: info?.sha ?? inferred.sha, dirty: inferred.dirty, inferred: true };
			}
			const caseMeta = meta.cases?.[index];
			const revision = caseMeta?.commit ?? meta.commit;
			if (revision) {
				const info = root ? resolveCommit(root, revision) : null;
				if (!info && !FULL_SHA.test(revision)) {
					throw new Error(`Cannot resolve revision "${revision}" in ${input.cwd}; fetch it or pass a full 40-character SHA.`);
				}
				commits.push(info);
				return { sha: info?.sha ?? revision, dirty: caseMeta?.dirty ?? meta.dirty ?? false, inferred: false };
			}
			commits.push(tree ? resolveCommit(tree.root, tree.head) : null);
			return { sha: tree?.head ?? null, dirty: caseMeta?.dirty ?? meta.dirty ?? tree?.dirty() ?? null, inferred: true };
		});
		if (!meta.commit && !meta.cases?.some((entry) => entry.commit) && !input.internal?.inferredCommits) {
			warnings.push(tree
				? `No commit recorded; attributed all cases to checkout HEAD ${tree.head.slice(0, 12)}${tree.dirty() ? " (dirty)" : ""}.`
				: "No commit recorded and the working directory is not a git checkout; measurements are not attributable to commits.");
		}
		const keys = caseKeys(cases, meta, resolved.map((entry) => entry.sha));
		const seen = new Map<string, number>();
		keys.forEach((key, index) => {
			const signature = `${key}\0${resolved[index].sha}\0${resolved[index].dirty}`;
			if (seen.has(signature)) {
				warnings.push(`Cases ${seen.get(signature)! + 1} and ${index + 1} share series "${key}" at the same revision; set distinct case keys if they measure different work.`);
			} else seen.set(signature, index);
		});
		const benchmarkKey = meta.benchmark ?? slug(meta.title ?? "default");
		const recordedAt = input.internal?.recordedAt ?? new Date().toISOString();
		const id = runId(new Date(recordedAt));

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
			const machineId = this.upsertMachine(meta.machine ?? localMachine());
			this.db.prepare(`INSERT INTO run (id, repository_id, machine_id, recorded_at, title, conditions, environment, invocation,
				warmup, notes, baseline_position, export_sha256, source_path, checkout_path, checkout_head, checkout_branch,
				checkout_dirty, legacy_id) VALUES (:id, :repository_id, :machine_id, :recorded_at, :title, :conditions,
				:environment, :invocation, :warmup, :notes, :baseline_position, :export_sha256, :source_path, :checkout_path,
				:checkout_head, :checkout_branch, :checkout_dirty, :legacy_id)`).run({
				id, repository_id: repository.id, machine_id: machineId, recorded_at: recordedAt, title: meta.title ?? null,
				conditions: meta.conditions ?? null, environment: meta.environment ?? null, invocation: meta.invocation ?? null,
				warmup: meta.warmup ?? null, notes: meta.notes ?? null, baseline_position: meta.baseline ?? null,
				export_sha256: sha256, source_path: source, checkout_path: checkout?.path ?? null, checkout_head: checkout?.head ?? null,
				checkout_branch: checkout?.branch ?? null, checkout_dirty: checkout?.dirty == null ? null : Number(checkout.dirty),
				legacy_id: input.internal?.legacyId ?? null,
			});
			const insert = this.db.prepare(`INSERT INTO measurement (run_id, position, benchmark_id, case_key, label, command,
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
			return { run: this.run(id)!, measurements: this.runMeasurements(id), benchmark, repository, warnings };
		});
	}

	/** Synchronizes a GitHub pull request's commits; `reference` is `123`, `owner/name#123` or a URL. */
	async syncGithubPullRequest(options: { cwd?: string; repositoryId?: number; reference: string | number }): Promise<PullRequest> {
		const reference = parsePullRequestReference(String(options.reference));
		const known = options.repositoryId === undefined ? undefined : this.repository(options.repositoryId);
		const cwd = options.cwd ?? (known?.localPath && fs.existsSync(known.localPath) ? known.localPath : undefined);
		const identity = cwd ? repositoryIdentity(cwd) : undefined;
		const candidates = reference.githubRepo ? [reference.githubRepo]
			: [...new Set([...(cwd ? githubRemotes(cwd) : []), ...(known?.githubRepo ? [known.githubRepo] : [])])];
		if (!candidates.length) throw new Error("Cannot infer the GitHub repository; pass owner/name#number or a pull request URL.");
		let pr: Awaited<ReturnType<typeof fetchPullRequest>> | undefined;
		const errors: string[] = [];
		for (const githubRepo of candidates) {
			try {
				pr = await fetchPullRequest(githubRepo, reference.number);
				break;
			} catch (error) { errors.push((error as Error).message); }
		}
		if (!pr) throw new Error(errors.join("\n"));
		const base = pr.baseSha ? (cwd ? resolveCommit(cwd, pr.baseSha) : null) ?? await fetchCommit(pr.githubRepo, pr.baseSha) : null;
		const fetched = pr;
		return this.transaction(() => {
			const repository = identity ? this.upsertRepository(identity) : known ?? this.repositoryByGithub(fetched.githubRepo) ??
				this.upsertRepository({ slug: `github.com/${fetched.githubRepo}`, name: fetched.githubRepo.split("/")[1], remoteUrl: null, githubRepo: fetched.githubRepo, root: null });
			return this.storePullRequest(repository.id, {
				source: "github", githubRepo: fetched.githubRepo, number: fetched.number, title: fetched.title, url: fetched.url,
				state: fetched.state, author: fetched.author, headRef: fetched.headRef, headSha: fetched.headSha,
				baseRef: fetched.baseRef, baseSha: fetched.baseSha, updatedAt: fetched.updatedAt,
			}, base, fetched.commits);
		});
	}

	/** Tracks a local branch like a pull request: commits in `base..head`, oldest first. */
	syncLocalBranch(options: { cwd: string; head?: string; base?: string; title?: string }): PullRequest {
		const tree = workingTree(options.cwd);
		if (!tree) throw new Error(`${options.cwd} is not a git checkout.`);
		const headRef = options.head ?? tree.branch;
		if (!headRef) throw new Error("HEAD is detached; pass the branch to track.");
		const head = resolveCommit(tree.root, headRef);
		if (!head) throw new Error(`Cannot resolve ${headRef}.`);
		const candidates = options.base ? [options.base] : ["upstream/HEAD", "origin/HEAD", "upstream/main", "origin/main", "main", "master"];
		let best: { ref: string; base: string; commits: CommitInfo[] } | undefined;
		for (const ref of candidates) {
			if (!resolveCommit(tree.root, ref)) continue;
			const base = mergeBase(tree.root, ref, head.sha);
			const commits = commitRange(tree.root, base, head.sha);
			// The closest base yields the fewest branch-only commits.
			if (!best || commits.length < best.commits.length) best = { ref, base, commits };
		}
		if (!best) throw new Error(options.base ? `Cannot resolve base ${options.base}.` : "Cannot find a base branch; pass one explicitly.");
		const chosen = best;
		const identity = repositoryIdentity(tree.root);
		return this.transaction(() => {
			const repository = this.upsertRepository(identity);
			return this.storePullRequest(repository.id, {
				source: "local", githubRepo: null, number: null, title: options.title ?? headRef, url: null, state: "open",
				author: head.author, headRef, headSha: head.sha, baseRef: chosen.ref, baseSha: chosen.base, updatedAt: head.committedAt,
			}, resolveCommit(tree.root, chosen.base), chosen.commits);
		});
	}

	async resyncPullRequest(id: number): Promise<PullRequest> {
		const pr = this.pullRequest(id);
		if (!pr) throw new Error(`Unknown pull request ${id}.`);
		if (pr.source === "github") {
			return this.syncGithubPullRequest({ repositoryId: pr.repositoryId, reference: `${pr.githubRepo}#${pr.number}` });
		}
		const repository = this.repository(pr.repositoryId)!;
		if (!repository.localPath || !fs.existsSync(repository.localPath)) throw new Error("The tracked checkout no longer exists.");
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
			? this.db.prepare("SELECT id FROM pull_request WHERE source = 'github' AND github_repo = ? AND number = ?").get(pr.githubRepo, pr.number)
			: this.db.prepare("SELECT id FROM pull_request WHERE source = 'local' AND repository_id = ? AND head_ref = ?").get(repositoryId, pr.headRef)) as { id: number } | undefined;
		let id: number;
		if (existing) {
			id = existing.id;
			this.db.prepare(`UPDATE pull_request SET repository_id = :repository_id, title = :title, url = :url, state = :state,
				author = :author, head_sha = :head_sha, base_ref = :base_ref, base_sha = :base_sha, updated_at = :updated_at,
				synced_at = :synced_at WHERE id = :id`).run({
				id, repository_id: values.repository_id, title: values.title, url: values.url, state: values.state, author: values.author,
				head_sha: values.head_sha, base_ref: values.base_ref, base_sha: values.base_sha, updated_at: values.updated_at,
				synced_at: values.synced_at,
			});
		} else {
			id = Number(this.db.prepare(`INSERT INTO pull_request (repository_id, source, github_repo, number, title, url, state,
				author, head_ref, head_sha, base_ref, base_sha, updated_at, synced_at) VALUES (:repository_id, :source, :github_repo,
				:number, :title, :url, :state, :author, :head_ref, :head_sha, :base_ref, :base_sha, :updated_at, :synced_at)`)
				.run(values).lastInsertRowid);
		}
		if (base) this.upsertCommit(repositoryId, base);
		this.db.prepare("DELETE FROM pull_request_commit WHERE pull_request_id = ?").run(id);
		const insert = this.db.prepare("INSERT INTO pull_request_commit (pull_request_id, position, sha) VALUES (?, ?, ?)");
		commits.forEach((commit, index) => {
			this.upsertCommit(repositoryId, commit);
			insert.run(id, index + 1, commit.sha);
		});
		return this.pullRequest(id)!;
	}

	deleteRun(id: string): boolean {
		return this.db.prepare("DELETE FROM run WHERE id = ?").run(id).changes > 0;
	}

	// ── Reads ─────────────────────────────────────────────────────────────────

	repositories(): Repository[] {
		return this.db.prepare("SELECT * FROM repository ORDER BY name, slug").all().map((row) => mapRow<Repository>(row));
	}
	repository(id: number): Repository | undefined {
		const row = this.db.prepare("SELECT * FROM repository WHERE id = ?").get(id);
		return row ? mapRow<Repository>(row) : undefined;
	}
	repositoryBySlug(slugValue: string): Repository | undefined {
		const row = this.db.prepare("SELECT * FROM repository WHERE slug = ?").get(slugValue);
		return row ? mapRow<Repository>(row) : undefined;
	}
	repositoryByGithub(githubRepo: string): Repository | undefined {
		const row = this.db.prepare("SELECT * FROM repository WHERE github_repo = ? OR slug = ? LIMIT 1").get(githubRepo, `github.com/${githubRepo}`);
		return row ? mapRow<Repository>(row) : undefined;
	}
	/** The repository a checkout belongs to, if it has been recorded. */
	repositoryForCheckout(cwd: string): Repository | undefined {
		return this.repositoryBySlug(repositoryIdentity(cwd).slug);
	}

	commit(repositoryId: number, sha: string): Commit | undefined {
		const row = this.db.prepare("SELECT * FROM git_commit WHERE repository_id = ? AND sha = ?").get(repositoryId, sha);
		return row ? toCommit(row) : undefined;
	}
	commitsByPrefix(repositoryId: number, prefix: string): Commit[] {
		return this.db.prepare("SELECT * FROM git_commit WHERE repository_id = ? AND sha LIKE ? || '%' LIMIT 10")
			.all(repositoryId, prefix.toLowerCase().replace(/[^0-9a-f]/g, "")).map(toCommit);
	}

	pullRequests(repositoryId?: number): PullRequest[] {
		const rows = repositoryId === undefined
			? this.db.prepare("SELECT * FROM pull_request ORDER BY coalesce(updated_at, synced_at) DESC").all()
			: this.db.prepare("SELECT * FROM pull_request WHERE repository_id = ? ORDER BY coalesce(updated_at, synced_at) DESC").all(repositoryId);
		return rows.map((row) => mapRow<PullRequest>(row));
	}
	pullRequest(id: number): PullRequest | undefined {
		const row = this.db.prepare("SELECT * FROM pull_request WHERE id = ?").get(id);
		return row ? mapRow<PullRequest>(row) : undefined;
	}
	findPullRequest(repositoryId: number, reference: string): PullRequest | undefined {
		const numeric = /^#?(\d+)$/.exec(reference);
		const row = numeric
			? this.db.prepare("SELECT * FROM pull_request WHERE repository_id = ? AND number = ? ORDER BY synced_at DESC LIMIT 1").get(repositoryId, Number(numeric[1]))
			: this.db.prepare("SELECT * FROM pull_request WHERE repository_id = ? AND head_ref = ? ORDER BY synced_at DESC LIMIT 1").get(repositoryId, reference);
		return row ? mapRow<PullRequest>(row) : undefined;
	}
	/** Ordered PR commits, excluding the base. */
	pullRequestCommits(id: number): Commit[] {
		return this.db.prepare(`SELECT c.* FROM pull_request_commit p
			JOIN pull_request pr ON pr.id = p.pull_request_id
			JOIN git_commit c ON c.repository_id = pr.repository_id AND c.sha = p.sha
			WHERE p.pull_request_id = ? ORDER BY p.position`).all(id).map(toCommit);
	}
	pullRequestsForCommit(repositoryId: number, sha: string): PullRequest[] {
		return this.db.prepare(`SELECT DISTINCT pr.* FROM pull_request pr LEFT JOIN pull_request_commit p ON p.pull_request_id = pr.id
			WHERE pr.repository_id = ? AND (p.sha = ? OR pr.base_sha = ?) ORDER BY pr.synced_at DESC`)
			.all(repositoryId, sha, sha).map((row) => mapRow<PullRequest>(row));
	}

	benchmarks(repositoryId: number): Benchmark[] {
		return this.db.prepare("SELECT * FROM benchmark WHERE repository_id = ? ORDER BY key").all(repositoryId).map((row) => mapRow<Benchmark>(row));
	}
	benchmark(id: number): Benchmark | undefined {
		const row = this.db.prepare("SELECT * FROM benchmark WHERE id = ?").get(id);
		return row ? mapRow<Benchmark>(row) : undefined;
	}
	benchmarkByKey(repositoryId: number, key: string): Benchmark | undefined {
		const row = this.db.prepare("SELECT * FROM benchmark WHERE repository_id = ? AND key = ?").get(repositoryId, key);
		return row ? mapRow<Benchmark>(row) : undefined;
	}
	benchmarkCases(benchmarkId: number): { caseKey: string; count: number; lastRecordedAt: string }[] {
		return this.db.prepare(`SELECT m.case_key, count(*) AS count, max(r.recorded_at) AS last_recorded_at
			FROM measurement m JOIN run r ON r.id = m.run_id WHERE m.benchmark_id = ? GROUP BY m.case_key ORDER BY m.case_key`)
			.all(benchmarkId).map((row) => mapRow(row));
	}

	machine(id: number): Machine | undefined {
		const row = this.db.prepare("SELECT * FROM machine WHERE id = ?").get(id);
		return row ? mapRow<Machine>(row) : undefined;
	}

	runs(options: { repositoryId?: number; benchmarkId?: number; limit?: number; offset?: number } = {}): Run[] {
		const limit = Math.min(Math.max(options.limit ?? 50, 1), 500);
		const where: string[] = [];
		const params: SQLInputValue[] = [];
		if (options.repositoryId !== undefined) { where.push("r.repository_id = ?"); params.push(options.repositoryId); }
		if (options.benchmarkId !== undefined) {
			where.push("EXISTS (SELECT 1 FROM measurement m WHERE m.run_id = r.id AND m.benchmark_id = ?)");
			params.push(options.benchmarkId);
		}
		return this.db.prepare(`SELECT r.* FROM run r ${where.length ? "WHERE " + where.join(" AND ") : ""}
			ORDER BY r.recorded_at DESC, r.id DESC LIMIT ? OFFSET ?`).all(...params, limit, options.offset ?? 0).map(toRun);
	}
	runCount(repositoryId?: number): number {
		const row = repositoryId === undefined
			? this.db.prepare("SELECT count(*) AS n FROM run").get()
			: this.db.prepare("SELECT count(*) AS n FROM run WHERE repository_id = ?").get(repositoryId);
		return (row as { n: number }).n;
	}
	run(id: string): Run | undefined {
		const row = this.db.prepare("SELECT * FROM run WHERE id = ?").get(id);
		return row ? toRun(row) : undefined;
	}
	runMeasurements(runId: string): Measurement[] {
		return this.db.prepare(`SELECT ${MEASUREMENT_COLUMNS} FROM measurement m JOIN run r ON r.id = m.run_id
			WHERE m.run_id = ? ORDER BY m.position`).all(runId).map(toMeasurement);
	}
	measurement(id: number): Measurement | undefined {
		const row = this.db.prepare(`SELECT ${MEASUREMENT_COLUMNS} FROM measurement m JOIN run r ON r.id = m.run_id WHERE m.id = ?`).get(id);
		return row ? toMeasurement(row) : undefined;
	}
	measurementsForCommits(repositoryId: number, shas: string[]): Measurement[] {
		if (!shas.length) return [];
		return this.db.prepare(`SELECT ${MEASUREMENT_COLUMNS} FROM measurement m JOIN run r ON r.id = m.run_id
			WHERE r.repository_id = ? AND m.commit_sha IN (SELECT value FROM json_each(?))
			ORDER BY r.recorded_at, m.position`).all(repositoryId, JSON.stringify(shas)).map(toMeasurement);
	}
	seriesMeasurements(benchmarkId: number, caseKey?: string, limit = 1000): Measurement[] {
		const rows = caseKey === undefined
			? this.db.prepare(`SELECT ${MEASUREMENT_COLUMNS} FROM measurement m JOIN run r ON r.id = m.run_id
				WHERE m.benchmark_id = ? ORDER BY r.recorded_at DESC, m.position LIMIT ?`).all(benchmarkId, limit)
			: this.db.prepare(`SELECT ${MEASUREMENT_COLUMNS} FROM measurement m JOIN run r ON r.id = m.run_id
				WHERE m.benchmark_id = ? AND m.case_key = ? ORDER BY r.recorded_at DESC, m.position LIMIT ?`).all(benchmarkId, caseKey, limit);
		return rows.map(toMeasurement).reverse();
	}

	times(measurementId: number): number[] {
		const row = this.db.prepare("SELECT times FROM measurement WHERE id = ?").get(measurementId) as { times: string } | undefined;
		return row ? JSON.parse(row.times) : [];
	}
	exitCodes(measurementId: number): number[] | null {
		const row = this.db.prepare("SELECT exit_codes FROM measurement WHERE id = ?").get(measurementId) as { exit_codes: string | null } | undefined;
		return row?.exit_codes ? JSON.parse(row.exit_codes) : null;
	}
}
