import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { repositoryIdentity, resolveCommit, type RepositoryIdentity } from "./git.ts";
import { prepareRun, type PreparedRun } from "./prepare.ts";

const LEGACY_ID = /^\d{8}T\d{9}Z-[\da-f]{8}$/;

interface LegacyManifest {
	version: 1;
	id: string;
	importedAt: string;
	source: string;
	sha256: string;
	options: {
		title?: string; baseline?: number; warmup?: number; conditions?: string; environment?: string; invocation?: string;
		cases?: { name?: string; command?: string; revision?: string; build?: string; notes?: string }[];
	};
	repository: { key: string; cwd: string; root?: string; head?: string; dirty?: boolean };
	recorder: { hostname: string; os: string; arch: string; cpu: string; ram: number };
}

export interface LegacyImportResult {
	imported: number;
	skipped: number;
	failed: { id: string; error: string }[];
}

/** First existing checkout for a legacy repository record, or a path-based identity if none survives. */
const located = new Map<string, { identity: RepositoryIdentity; checkout: string | null }>();
function locate(repository: LegacyManifest["repository"]): { identity: RepositoryIdentity; checkout: string | null } {
	const key = JSON.stringify([repository.root, repository.cwd, repository.key]);
	let result = located.get(key);
	if (!result) located.set(key, result = locateUncached(repository));
	return result;
}
function locateUncached(repository: LegacyManifest["repository"]): { identity: RepositoryIdentity; checkout: string | null } {
	const candidates = [repository.root, repository.cwd, path.basename(repository.key) === ".git" ? path.dirname(repository.key) : undefined];
	for (const candidate of candidates) {
		if (candidate && fs.existsSync(candidate)) {
			const identity = repositoryIdentity(candidate);
			if (identity.root) return { identity, checkout: candidate };
		}
	}
	return {
		identity: { slug: `local:${repository.key}`, name: path.basename(path.dirname(repository.key)) || repository.key, remoteUrl: null, githubRepo: null, root: null },
		checkout: null,
	};
}

/** Best-effort attribution of free-form legacy revision notes to a commit and dirty state. */
export function inferRevision(text: string | undefined, checkout: string | null, head?: string, headDirty?: boolean): { sha: string | null; dirty: boolean | null } {
	let sha: string | null = null;
	const full = text?.match(/\b[0-9a-f]{40}\b/);
	if (full) sha = full[0];
	else if (text && checkout) {
		for (const candidate of text.match(/\b[0-9a-f]{7,39}\b/g) ?? []) {
			const resolved = resolveCommit(checkout, candidate);
			if (resolved) { sha = resolved.sha; break; }
		}
	}
	let dirty: boolean | null = null;
	if (text && /\bdirty\b|uncommitted|working[- ]tree|\+\s*\S*\s*patch/i.test(text)) dirty = true;
	else if (text && /\bclean\b/i.test(text)) dirty = false;
	if (!sha) return { sha: head ?? null, dirty: dirty ?? headDirty ?? null };
	return { sha, dirty: dirty ?? (sha === head ? headDirty ?? null : null) };
}

/** Where imported runs go: a local store or a server, given the legacy IDs it already has. */
export interface LegacyImportTarget {
	known: Set<string>;
	ingest(run: PreparedRun): unknown;
}

/** Imports the `/bench` extension's per-run directories (manifest.json + hyperfine.json). Idempotent. */
export async function importLegacy(target: LegacyImportTarget, directory: string): Promise<LegacyImportResult> {
	const result: LegacyImportResult = { imported: 0, skipped: 0, failed: [] };
	if (!fs.existsSync(directory)) return result;
	for (const id of fs.readdirSync(directory).filter((name) => LEGACY_ID.test(name)).sort()) {
		if (target.known.has(id)) { result.skipped++; continue; }
		try {
			const folder = path.join(directory, id);
			const manifest = JSON.parse(fs.readFileSync(path.join(folder, "manifest.json"), "utf8")) as LegacyManifest;
			if (manifest.version !== 1 || manifest.id !== id) throw new Error("Unexpected manifest version or ID.");
			const file = path.join(folder, "hyperfine.json");
			const digest = createHash("sha256").update(fs.readFileSync(file)).digest("hex");
			if (digest !== manifest.sha256) throw new Error("hyperfine.json does not match its recorded digest.");
			const { identity, checkout } = locate(manifest.repository);
			const exported = JSON.parse(fs.readFileSync(file, "utf8")) as { results: unknown[] };
			const options = manifest.options;
			const inferredCommits = exported.results.map((_, index) => inferRevision(
				options.cases?.[index]?.revision, checkout, manifest.repository.head, manifest.repository.dirty,
			));
			await target.ingest(prepareRun({
				file, cwd: checkout ?? folder,
				metadata: {
					title: options.title, baseline: options.baseline, warmup: options.warmup, conditions: options.conditions,
					environment: options.environment, invocation: options.invocation,
					notes: `Imported from pi /bench ${id}; commits inferred from recorded revisions.`,
					machine: manifest.recorder,
					cases: options.cases?.map((entry) => ({
						name: entry.name, command: entry.command, revision: entry.revision, build: entry.build, notes: entry.notes,
					})),
				},
				internal: {
					recordedAt: manifest.importedAt, legacyId: id, inferredCommits, repository: identity,
					checkout: {
						path: manifest.repository.root ?? manifest.repository.cwd, head: manifest.repository.head ?? null,
						branch: null, dirty: manifest.repository.dirty ?? null,
					},
				},
			}));
			result.imported++;
		} catch (error) {
			result.failed.push({ id, error: (error as Error).message });
		}
	}
	return result;
}
