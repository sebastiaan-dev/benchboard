/**
 * Client configuration: which server the CLI talks to and with which token.
 *
 * Precedence: --server / --local flags, then BENCHBOARD_SERVER (+ BENCHBOARD_TOKEN), then the saved
 * login (`benchboard login`), else the local data directory. An explicit --home always means local.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { normalizeServerUrl } from "./remote.ts";

export interface SavedLogin {
	server: string;
	token: string;
}

export function configFile(): string {
	const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
	return path.join(base, "benchboard", "login.json");
}

export function readLogin(): SavedLogin | null {
	try {
		const value = JSON.parse(fs.readFileSync(configFile(), "utf8")) as Partial<SavedLogin>;
		return typeof value.server === "string" && typeof value.token === "string" ? { server: value.server, token: value.token } : null;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw new Error(`Cannot read ${configFile()}: ${(error as Error).message}`);
	}
}

export function saveLogin(login: SavedLogin) {
	const file = configFile();
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	const temporary = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(temporary, JSON.stringify({ server: normalizeServerUrl(login.server), token: login.token }, null, 2) + "\n", { mode: 0o600 });
	fs.renameSync(temporary, file);
}

export function removeLogin(): boolean {
	try {
		fs.unlinkSync(configFile());
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

export type Target = { kind: "local"; home: string | undefined } | { kind: "remote"; server: string; token: string | null };

export function resolveTarget(options: { server?: string; local?: boolean; home?: string }): Target {
	if (options.server && (options.local || options.home)) throw new Error("Pass either --server or --local/--home, not both.");
	if (options.local || options.home) return { kind: "local", home: options.home };
	const token = process.env.BENCHBOARD_TOKEN || null;
	if (options.server) {
		const server = normalizeServerUrl(options.server);
		const saved = readLogin();
		return { kind: "remote", server, token: token ?? (saved && normalizeServerUrl(saved.server) === server ? saved.token : null) };
	}
	if (process.env.BENCHBOARD_SERVER) {
		const server = normalizeServerUrl(process.env.BENCHBOARD_SERVER);
		const saved = readLogin();
		return { kind: "remote", server, token: token ?? (saved && normalizeServerUrl(saved.server) === server ? saved.token : null) };
	}
	// BENCHBOARD_HOME selects a local data directory, even when a login is saved.
	if (process.env.BENCHBOARD_HOME) return { kind: "local", home: undefined };
	const saved = readLogin();
	if (saved) return { kind: "remote", server: normalizeServerUrl(saved.server), token: token ?? saved.token };
	return { kind: "local", home: undefined };
}
