/**
 * Access control for servers: bearer tokens with a scope. Tokens are random (256 bits), so a plain
 * SHA-256 digest is a sufficient verifier; the token itself is shown once, at creation.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Store } from "./store.ts";

export const SCOPES = ["read", "write", "admin"] as const;
export type Scope = (typeof SCOPES)[number];

/** read: view everything · write: also ingest, track and sync · admin: also delete. */
export const allows = (granted: Scope | null, needed: Scope) => granted !== null && SCOPES.indexOf(granted) >= SCOPES.indexOf(needed);

export function parseScope(value: string): Scope {
	if (!(SCOPES as readonly string[]).includes(value)) throw new Error(`Scope must be one of ${SCOPES.join(", ")}.`);
	return value as Scope;
}

export interface ApiToken {
	id: number;
	name: string;
	scope: Scope;
	prefix: string;
	createdAt: string;
	lastUsedAt: string | null;
	revokedAt: string | null;
}

export interface Principal {
	name: string;
	scope: Scope;
	/** Null for implicit principals (the local, unauthenticated mode). */
	tokenId: number | null;
}

const TOKEN = /^bb_[A-Za-z0-9_-]{43}$/;
const digest = (token: string) => createHash("sha256").update(token).digest("hex");
const toToken = (row: Record<string, unknown>): ApiToken => ({
	id: row.id as number, name: row.name as string, scope: row.scope as Scope, prefix: row.prefix as string,
	createdAt: row.created_at as string, lastUsedAt: row.last_used_at as string | null, revokedAt: row.revoked_at as string | null,
});

export function createToken(store: Store, name: string, scope: Scope): { token: string; record: ApiToken } {
	if (!/^[\w.@:-]{1,100}$/.test(name)) throw new Error("Token names use letters, digits and . _ - @ : (at most 100).");
	parseScope(scope);
	const token = `bb_${randomBytes(32).toString("base64url")}`;
	try {
		const id = Number(store.db.query(`INSERT INTO api_token (name, scope, prefix, hash, created_at) VALUES (?, ?, ?, ?, ?)`)
			.run(name, scope, token.slice(0, 10), digest(token), new Date().toISOString()).lastInsertRowid);
		return { token, record: toToken(store.db.query("SELECT * FROM api_token WHERE id = ?").get(id) as Record<string, unknown>) };
	} catch (error) {
		if (String(error).includes("UNIQUE")) throw new Error(`An active token named "${name}" exists; revoke it first or pick another name.`);
		throw error;
	}
}

export function listTokens(store: Store, options: { includeRevoked?: boolean } = {}): ApiToken[] {
	const rows = store.db.query(`SELECT * FROM api_token ${options.includeRevoked ? "" : "WHERE revoked_at IS NULL"} ORDER BY id`).all();
	return (rows as Record<string, unknown>[]).map(toToken);
}

/** Revokes by ID or by active name; returns whether a token was revoked. */
export function revokeToken(store: Store, reference: string): boolean {
	const now = new Date().toISOString();
	const result = /^\d+$/.test(reference)
		? store.db.query("UPDATE api_token SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(now, Number(reference))
		: store.db.query("UPDATE api_token SET revoked_at = ? WHERE name = ? AND revoked_at IS NULL").run(now, reference);
	return result.changes > 0;
}

const USE_RESOLUTION_MS = 5 * 60_000;

export function authenticate(store: Store, token: string): Principal | null {
	if (!TOKEN.test(token)) return null;
	const hash = digest(token);
	const row = store.db.query("SELECT * FROM api_token WHERE hash = ? AND revoked_at IS NULL").get(hash) as Record<string, unknown> | null;
	if (!row || !timingSafeEqual(Buffer.from(row.hash as string), Buffer.from(hash))) return null;
	const record = toToken(row);
	// Last use is coarse (a write per token every few minutes at most), which is enough to spot stale tokens.
	if (!record.lastUsedAt || Date.now() - Date.parse(record.lastUsedAt) > USE_RESOLUTION_MS) {
		store.db.query("UPDATE api_token SET last_used_at = ? WHERE id = ?").run(new Date().toISOString(), record.id);
	}
	return { name: record.name, scope: record.scope, tokenId: record.id };
}

/** A per-installation secret (for signed links), created on first use and kept with the data. */
export function serverSecret(home: string): Buffer {
	const file = path.join(home, "secret.key");
	try {
		const existing = fs.readFileSync(file);
		if (existing.length >= 32) return existing;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	fs.mkdirSync(home, { recursive: true, mode: 0o700 });
	const secret = randomBytes(32);
	try {
		fs.writeFileSync(file, secret, { mode: 0o600, flag: "wx" });
		return secret;
	} catch (error) {
		// Another process created it first.
		if ((error as NodeJS.ErrnoException).code === "EEXIST") return fs.readFileSync(file);
		throw error;
	}
}
