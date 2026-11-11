/**
 * Backups and integrity checks for a data directory.
 *
 * Layout: `benchboard.db` (SQLite, WAL) plus content-addressed, immutable blobs under `exports/` and
 * `profiles/`, and `secret.key`. Blobs are written before the rows that reference them and are never
 * deleted, so a database snapshot followed by a copy of the blobs is always self-consistent.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { SCHEMA_VERSION } from "./db.ts";
import type { Store } from "./store.ts";

export interface BackupResult {
	directory: string;
	schemaVersion: number;
	/** Blobs copied now; blobs already present in the destination are skipped (incremental). */
	copied: number;
	skipped: number;
	bytes: number;
}

function copyBlobs(from: string, to: string, result: BackupResult) {
	if (!fs.existsSync(from)) return;
	fs.mkdirSync(to, { recursive: true, mode: 0o700 });
	for (const name of fs.readdirSync(from)) {
		if (name.endsWith(".tmp")) continue;
		const target = path.join(to, name);
		if (fs.existsSync(target)) { result.skipped++; continue; }
		const source = path.join(from, name);
		// Copy to a temporary name first so an interrupted backup never leaves a truncated blob.
		fs.copyFileSync(source, `${target}.tmp`);
		fs.renameSync(`${target}.tmp`, target);
		result.copied++;
		result.bytes += fs.statSync(target).size;
	}
}

/** Writes a consistent copy of the data directory to `directory`; safe while the server is running. */
export function backup(store: Store, directory: string): BackupResult {
	const target = path.resolve(directory);
	if (path.resolve(store.home) === target) throw new Error("The backup directory must differ from the data directory.");
	fs.mkdirSync(target, { recursive: true, mode: 0o700 });
	const result: BackupResult = { directory: target, schemaVersion: SCHEMA_VERSION, copied: 0, skipped: 0, bytes: 0 };
	const database = path.join(target, "benchboard.db");
	const temporary = `${database}.${process.pid}.tmp`;
	fs.rmSync(temporary, { force: true });
	store.db.run(`VACUUM INTO '${temporary.replaceAll("'", "''")}'`);
	fs.renameSync(temporary, database);
	fs.chmodSync(database, 0o600);
	for (const stale of ["-wal", "-shm"]) fs.rmSync(database + stale, { force: true });
	result.bytes += fs.statSync(database).size;
	copyBlobs(path.join(store.home, "exports"), path.join(target, "exports"), result);
	copyBlobs(path.join(store.home, "profiles"), path.join(target, "profiles"), result);
	const secret = path.join(store.home, "secret.key");
	if (fs.existsSync(secret)) fs.copyFileSync(secret, path.join(target, "secret.key"));
	fs.writeFileSync(path.join(target, "backup.json"), JSON.stringify({
		createdAt: new Date().toISOString(), schemaVersion: SCHEMA_VERSION, source: store.home,
	}, null, 2) + "\n", { mode: 0o600 });
	return result;
}

export interface VerifyResult {
	ok: boolean;
	schemaVersion: number;
	integrity: string[];
	foreignKeyViolations: number;
	missingExports: string[];
	missingProfiles: string[];
	counts: { runs: number; measurements: number; profiles: number; pullRequests: number };
}

/** Checks the database (integrity, foreign keys) and that every referenced blob exists. */
export function verify(store: Store): VerifyResult {
	const integrity = (store.db.query("PRAGMA integrity_check").all() as { integrity_check: string }[]).map((row) => row.integrity_check);
	const foreignKeyViolations = store.db.query("PRAGMA foreign_key_check").all().length;
	const exists = (dir: string, name: string) => fs.existsSync(path.join(store.home, dir, name));
	const exportDigests = (store.db.query("SELECT DISTINCT export_sha256 AS sha FROM run").all() as { sha: string }[]).map((row) => row.sha);
	const profileDigests = store.db.query("SELECT sha256, syms_sha256 FROM profile").all() as { sha256: string; syms_sha256: string | null }[];
	const missingExports = exportDigests.filter((sha) => !exists("exports", `${sha}.json`));
	const missingProfiles = [...new Set(profileDigests.flatMap((row) => [
		...(exists("profiles", `${row.sha256}.json.gz`) ? [] : [`${row.sha256}.json.gz`]),
		...(row.syms_sha256 && !exists("profiles", `${row.syms_sha256}.syms.json`) ? [`${row.syms_sha256}.syms.json`] : []),
	]))];
	const count = (table: string) => (store.db.query(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
	const okIntegrity = integrity.length === 1 && integrity[0] === "ok";
	return {
		ok: okIntegrity && foreignKeyViolations === 0 && !missingExports.length && !missingProfiles.length,
		schemaVersion: (store.db.query("PRAGMA user_version").get() as { user_version: number }).user_version,
		integrity, foreignKeyViolations, missingExports, missingProfiles,
		counts: { runs: count("run"), measurements: count("measurement"), profiles: count("profile"), pullRequests: count("pull_request") },
	};
}

export interface RestoreResult {
	directory: string;
	/** Where the replaced database went (only with `force`). */
	previous: string | null;
	files: number;
}

/**
 * Copies a backup into a data directory (stop the server first). An existing database is only
 * replaced with `force`, and then kept as `benchboard.db.before-restore-<time>`; stored files are
 * content-addressed, so the backup's are added to those already present.
 */
export function restore(backupDirectory: string, home: string, options: { force?: boolean } = {}): RestoreResult {
	const source = path.resolve(backupDirectory);
	const target = path.resolve(home);
	if (source === target) throw new Error("The backup directory must differ from the data directory.");
	if (!fs.existsSync(path.join(source, "benchboard.db"))) throw new Error(`${source} is not a Benchboard backup (no benchboard.db).`);
	const database = path.join(target, "benchboard.db");
	let previous: string | null = null;
	if (fs.existsSync(database)) {
		if (!options.force) throw new Error(`${target} already has a database; pass --force to replace it (it is kept as a copy).`);
		previous = `${database}.before-restore-${new Date().toISOString().replace(/[-:.]/g, "")}`;
		fs.renameSync(database, previous);
		for (const suffix of ["-wal", "-shm"]) if (fs.existsSync(database + suffix)) fs.renameSync(database + suffix, previous + suffix);
	}
	fs.mkdirSync(target, { recursive: true, mode: 0o700 });
	const result: BackupResult = { directory: target, schemaVersion: SCHEMA_VERSION, copied: 0, skipped: 0, bytes: 0 };
	copyBlobs(path.join(source, "exports"), path.join(target, "exports"), result);
	copyBlobs(path.join(source, "profiles"), path.join(target, "profiles"), result);
	if (fs.existsSync(path.join(source, "secret.key"))) fs.copyFileSync(path.join(source, "secret.key"), path.join(target, "secret.key"));
	// The database last, so a directory with a database always has its files.
	fs.copyFileSync(path.join(source, "benchboard.db"), `${database}.tmp`);
	fs.chmodSync(`${database}.tmp`, 0o600);
	fs.renameSync(`${database}.tmp`, database);
	return { directory: target, previous, files: result.copied };
}
