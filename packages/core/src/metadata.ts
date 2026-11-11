import { z } from "zod";

const text = z.string().max(16_384);
const key = z.string().min(1).max(200).regex(/^[a-z0-9][a-z0-9._/-]*$/, "Use lowercase letters, digits, '.', '_', '-' and '/'.");
const revision = z.string().min(1).max(256);

export const ProfileMetadata = z.union([
	z.string().min(1).max(4096),
	z.object({
		/** samply profile (`profile.json.gz`); its `.syms.json` sidecar is found automatically. */
		file: z.string().min(1).max(4096),
		syms: z.string().min(1).max(4096).optional(),
		/** Workload repetitions captured in the profile (`samply record --iteration-count`). */
		iterations: z.number().int().positive().optional(),
		label: z.string().max(200).optional(),
		command: z.string().max(16_384).optional(),
	}).strict(),
]);

export const CaseMetadata = z.object({
	/** Series key within the benchmark; the same key at different commits forms one line. */
	case: key.optional(),
	name: text.optional(),
	command: text.optional(),
	/** Measured source revision (SHA, branch or `HEAD~1`), resolved in the checkout. */
	commit: revision.optional(),
	/** Whether the measured build had uncommitted changes on top of `commit`. */
	dirty: z.boolean().optional(),
	revision: text.optional(),
	build: text.optional(),
	notes: text.optional(),
	/** Sampled profile(s) of this case's workload, e.g. from `samply record --save-only --unstable-presymbolicate`. */
	profile: z.union([ProfileMetadata, z.array(ProfileMetadata).max(16)]).optional(),
}).strict();

/** The machine that ran the measurements; unknown fields stay "unknown" rather than being filled from the importer. */
export const MachineMetadata = z.object({
	hostname: z.string().min(1).max(256),
	os: z.string().min(1).max(256).default("unknown"),
	arch: z.string().min(1).max(64).default("unknown"),
	cpu: z.string().min(1).max(256).default("unknown"),
	ram: z.number().int().nonnegative().default(0),
	/** Cloud instance type or similar, e.g. "Amazon EC2 c7g.2xlarge". */
	platform: z.string().min(1).max(256).nullable().default(null),
}).strict();

export const IngestMetadata = z.object({
	/** Stable benchmark identity, e.g. `variant/strip-nulls`; defaults to a slug of the title. */
	benchmark: key.optional(),
	title: text.optional(),
	description: text.optional(),
	/** One-based case used as the in-run comparison baseline. */
	baseline: z.number().int().positive().optional(),
	warmup: z.number().int().nonnegative().optional(),
	conditions: text.optional(),
	environment: text.optional(),
	invocation: text.optional(),
	notes: text.optional(),
	/** Defaults applied to cases that omit them. */
	commit: revision.optional(),
	dirty: z.boolean().optional(),
	build: text.optional(),
	/** Pull request to synchronize after ingesting: number, `owner/name#123` or URL. */
	pullRequest: z.union([z.number().int().positive(), z.string().min(1).max(512)]).optional(),
	/** Defaults to the importing machine; set it whenever the measurements ran elsewhere (CI, remote host, VM). */
	machine: MachineMetadata.optional(),
	cases: z.array(CaseMetadata).max(512).optional(),
}).strict();

export type CaseMetadata = z.infer<typeof CaseMetadata>;
export type IngestMetadata = z.output<typeof IngestMetadata>;
export type MachineMetadata = z.output<typeof MachineMetadata>;
export type ProfileMetadata = z.infer<typeof ProfileMetadata>;

export function parseMetadata(value: unknown): IngestMetadata {
	const result = IngestMetadata.safeParse(value ?? {});
	if (!result.success) {
		throw new Error("Invalid benchmark metadata:\n" + result.error.issues
			.map((issue) => `  ${issue.path.join(".") || "(root)"}: ${issue.message}`).join("\n"));
	}
	return result.data;
}

export function slug(value: string, fallback = "default", allowSlash = true): string {
	const result = value.toLowerCase().normalize("NFKD").replace(allowSlash ? /[^a-z0-9._/-]+/g : /[^a-z0-9._-]+/g, "-")
		.replace(/-{2,}/g, "-").replace(/^[^a-z0-9]+|[-./]+$/g, "").slice(0, 120).replace(/[-./]+$/, "");
	return result || fallback;
}
