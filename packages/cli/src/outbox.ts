/**
 * Uploads that could not reach the server, kept on disk until `benchboard push` delivers them, so an
 * expensive benchmark on a short-lived machine is not lost to a network blip or a server restart.
 *
 * Layout: `$XDG_STATE_HOME/benchboard/outbox/<id>/entry.json` (server, label and operations, with
 * binary values as `{ "$blob": i }`) plus `blob-<i>` files. Operations replay in order and are
 * idempotent (upload IDs, upserts), so a partially delivered entry can simply be pushed again.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { MethodName } from "./backend.ts";
import { deserialize, serialize } from "./wire.ts";

export interface Operation {
	method: MethodName;
	args: unknown[];
}

export interface OutboxEntry {
	id: string;
	server: string;
	createdAt: string;
	/** What it is, for listings: "run tpch/sf1 (3 operations)". */
	label: string;
	operations: Operation[];
	/** The last delivery error. */
	lastError?: string;
}

export function outboxDir(): string {
	const state = process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state");
	return path.join(state, "benchboard", "outbox");
}

export function enqueue(server: string, label: string, operations: Operation[], lastError?: string): string {
	const id = `${new Date().toISOString().replace(/[-:.]/g, "")}-${crypto.randomUUID().slice(0, 8)}`;
	const directory = path.join(outboxDir(), id);
	const temporary = `${directory}.tmp`;
	fs.mkdirSync(temporary, { recursive: true, mode: 0o700 });
	const { json, blobs } = serialize(operations);
	blobs.forEach((blob, index) => fs.writeFileSync(path.join(temporary, `blob-${index}`), blob, { mode: 0o600 }));
	fs.writeFileSync(path.join(temporary, "entry.json"), JSON.stringify({ id, server, createdAt: new Date().toISOString(), label, lastError, operations: json }, null, 2), { mode: 0o600 });
	// Complete entries only: a crash while writing leaves a .tmp directory that is ignored.
	fs.renameSync(temporary, directory);
	return directory;
}

export function pending(): OutboxEntry[] {
	const root = outboxDir();
	if (!fs.existsSync(root)) return [];
	return fs.readdirSync(root).filter((name) => !name.endsWith(".tmp") && fs.existsSync(path.join(root, name, "entry.json"))).sort().map((name) => {
		const directory = path.join(root, name);
		const stored = JSON.parse(fs.readFileSync(path.join(directory, "entry.json"), "utf8")) as Omit<OutboxEntry, "operations"> & { operations: string };
		const operations = deserialize(stored.operations, (index) => {
			const file = path.join(directory, `blob-${index}`);
			return fs.existsSync(file) ? new Uint8Array(fs.readFileSync(file)) : undefined;
		}) as Operation[];
		return { ...stored, operations };
	});
}

export function remove(id: string) {
	fs.rmSync(path.join(outboxDir(), id), { recursive: true, force: true });
}

export function recordError(id: string, message: string) {
	const file = path.join(outboxDir(), id, "entry.json");
	const stored = JSON.parse(fs.readFileSync(file, "utf8"));
	fs.writeFileSync(file, JSON.stringify({ ...stored, lastError: message }, null, 2), { mode: 0o600 });
}
