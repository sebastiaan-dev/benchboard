import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";

/** Ordered, append-only migrations; `PRAGMA user_version` records how many were applied. */
const MIGRATIONS: string[] = [
	`
	CREATE TABLE repository (
		id INTEGER PRIMARY KEY,
		slug TEXT NOT NULL UNIQUE,
		name TEXT NOT NULL,
		remote_url TEXT,
		github_repo TEXT,
		local_path TEXT,
		created_at TEXT NOT NULL
	);
	CREATE TABLE git_commit (
		repository_id INTEGER NOT NULL REFERENCES repository(id),
		sha TEXT NOT NULL,
		subject TEXT,
		author TEXT,
		authored_at TEXT,
		committed_at TEXT,
		parents TEXT NOT NULL DEFAULT '[]',
		PRIMARY KEY (repository_id, sha)
	) WITHOUT ROWID;
	CREATE TABLE pull_request (
		id INTEGER PRIMARY KEY,
		repository_id INTEGER NOT NULL REFERENCES repository(id),
		source TEXT NOT NULL CHECK (source IN ('github', 'local')),
		github_repo TEXT,
		number INTEGER,
		title TEXT NOT NULL,
		url TEXT,
		state TEXT NOT NULL,
		author TEXT,
		head_ref TEXT NOT NULL,
		head_sha TEXT NOT NULL,
		base_ref TEXT NOT NULL,
		base_sha TEXT,
		updated_at TEXT,
		synced_at TEXT NOT NULL,
		CHECK ((source = 'github') = (github_repo IS NOT NULL AND number IS NOT NULL))
	);
	CREATE UNIQUE INDEX pull_request_github ON pull_request (github_repo, number) WHERE source = 'github';
	CREATE UNIQUE INDEX pull_request_local ON pull_request (repository_id, head_ref) WHERE source = 'local';
	CREATE TABLE pull_request_commit (
		pull_request_id INTEGER NOT NULL REFERENCES pull_request(id) ON DELETE CASCADE,
		position INTEGER NOT NULL,
		sha TEXT NOT NULL,
		PRIMARY KEY (pull_request_id, position)
	) WITHOUT ROWID;
	CREATE INDEX pull_request_commit_sha ON pull_request_commit (sha);
	CREATE TABLE benchmark (
		id INTEGER PRIMARY KEY,
		repository_id INTEGER NOT NULL REFERENCES repository(id),
		key TEXT NOT NULL,
		title TEXT,
		description TEXT,
		UNIQUE (repository_id, key)
	);
	CREATE TABLE machine (
		id INTEGER PRIMARY KEY,
		fingerprint TEXT NOT NULL UNIQUE,
		hostname TEXT NOT NULL,
		os TEXT NOT NULL,
		arch TEXT NOT NULL,
		cpu TEXT NOT NULL,
		ram INTEGER NOT NULL
	);
	CREATE TABLE run (
		id TEXT PRIMARY KEY,
		repository_id INTEGER NOT NULL REFERENCES repository(id),
		machine_id INTEGER NOT NULL REFERENCES machine(id),
		recorded_at TEXT NOT NULL,
		title TEXT,
		conditions TEXT,
		environment TEXT,
		invocation TEXT,
		warmup INTEGER,
		notes TEXT,
		baseline_position INTEGER,
		export_sha256 TEXT NOT NULL,
		source_path TEXT,
		checkout_path TEXT,
		checkout_head TEXT,
		checkout_branch TEXT,
		checkout_dirty INTEGER,
		legacy_id TEXT UNIQUE
	);
	CREATE INDEX run_repository ON run (repository_id, recorded_at DESC);
	CREATE INDEX run_export ON run (export_sha256);
	CREATE TABLE measurement (
		id INTEGER PRIMARY KEY,
		run_id TEXT NOT NULL REFERENCES run(id) ON DELETE CASCADE,
		position INTEGER NOT NULL,
		benchmark_id INTEGER NOT NULL REFERENCES benchmark(id),
		case_key TEXT NOT NULL,
		label TEXT NOT NULL,
		command TEXT,
		exported_command TEXT NOT NULL,
		commit_sha TEXT,
		dirty INTEGER,
		commit_inferred INTEGER NOT NULL DEFAULT 0,
		revision TEXT,
		build TEXT,
		notes TEXT,
		parameters TEXT,
		status TEXT NOT NULL CHECK (status IN ('passed', 'failed', 'unverified')),
		n INTEGER NOT NULL,
		mean REAL NOT NULL,
		stddev REAL,
		median REAL NOT NULL,
		min REAL NOT NULL,
		max REAL NOT NULL,
		q1 REAL NOT NULL,
		q3 REAL NOT NULL,
		p95 REAL NOT NULL,
		cv REAL,
		user_time REAL,
		system_time REAL,
		rss_median REAL,
		rss_peak REAL,
		times TEXT NOT NULL,
		exit_codes TEXT,
		UNIQUE (run_id, position)
	);
	CREATE INDEX measurement_series ON measurement (benchmark_id, case_key, commit_sha);
	CREATE INDEX measurement_commit ON measurement (commit_sha);
	`,
	`
	CREATE TABLE profile (
		id INTEGER PRIMARY KEY,
		measurement_id INTEGER NOT NULL REFERENCES measurement(id) ON DELETE CASCADE,
		label TEXT,
		tool TEXT NOT NULL DEFAULT 'samply',
		sha256 TEXT NOT NULL,
		syms_sha256 TEXT,
		product TEXT,
		iterations INTEGER NOT NULL DEFAULT 1 CHECK (iterations > 0),
		samples INTEGER NOT NULL,
		interval_ms REAL NOT NULL,
		duration_ms REAL,
		threads TEXT NOT NULL,
		symbolicated_share REAL NOT NULL,
		node_count INTEGER NOT NULL,
		command TEXT,
		recorded_at TEXT NOT NULL,
		tree BLOB NOT NULL
	);
	CREATE INDEX profile_measurement ON profile (measurement_id);
	`,
	`
	-- Separate on-CPU from sampled (wall) time; trees older than tree_version 2 are re-aggregated from raw files.
	ALTER TABLE profile ADD COLUMN cpu_ms REAL NOT NULL DEFAULT 0;
	ALTER TABLE profile ADD COLUMN sampled_ms REAL NOT NULL DEFAULT 0;
	ALTER TABLE profile ADD COLUMN cpu_source TEXT NOT NULL DEFAULT 'sample-count';
	ALTER TABLE profile ADD COLUMN tree_version INTEGER NOT NULL DEFAULT 1;
	`,
	`
	-- API tokens for servers: only a SHA-256 digest is kept; the prefix identifies a token in listings.
	CREATE TABLE api_token (
		id INTEGER PRIMARY KEY,
		name TEXT NOT NULL,
		scope TEXT NOT NULL CHECK (scope IN ('read', 'write', 'admin')),
		prefix TEXT NOT NULL,
		hash TEXT NOT NULL UNIQUE,
		created_at TEXT NOT NULL,
		last_used_at TEXT,
		revoked_at TEXT
	);
	CREATE UNIQUE INDEX api_token_active_name ON api_token (name) WHERE revoked_at IS NULL;
	`,
];

export const SCHEMA_VERSION = MIGRATIONS.length;

export function openDatabase(file: string): Database {
	if (file !== ":memory:") {
		fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
		// The database holds token digests and everything recorded: readable by its owner only.
		if (!fs.existsSync(file)) fs.closeSync(fs.openSync(file, "a", 0o600));
	}
	// strict: named parameters bind from plain object keys (`:name` ↔ { name }).
	const db = new Database(file, { create: true, strict: true });
	db.run("PRAGMA busy_timeout = 5000");
	db.run("PRAGMA journal_mode = WAL");
	db.run("PRAGMA foreign_keys = ON");
	db.run("PRAGMA synchronous = NORMAL");
	const { user_version: version } = db.query("PRAGMA user_version").get() as { user_version: number };
	if (version > MIGRATIONS.length) {
		throw new Error(`Database ${file} has schema version ${version}; this benchboard supports ${MIGRATIONS.length}. Upgrade benchboard.`);
	}
	if (version > 0 && version < MIGRATIONS.length && file !== ":memory:") {
		// Keep a consistent copy of the database as it was before upgrading, so a bad upgrade can be undone.
		const snapshot = `${file}.v${version}.bak`;
		if (!fs.existsSync(snapshot)) db.run(`VACUUM INTO '${snapshot.replaceAll("'", "''")}'`);
	}
	for (let index = version; index < MIGRATIONS.length; index++) {
		db.run("BEGIN IMMEDIATE");
		try {
			db.run(MIGRATIONS[index]);
			db.run(`PRAGMA user_version = ${index + 1}`);
			db.run("COMMIT");
		} catch (error) {
			db.run("ROLLBACK");
			throw error;
		}
	}
	return db;
}
