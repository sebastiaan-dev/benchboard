/**
 * Wire format of the RPC API: arguments travel as JSON; binary values (exports, profiles) as separate
 * multipart parts referenced from the JSON by `{ "$blob": <index> }`. Requests without binary values
 * are plain `application/json`.
 */
export type Encoded = { body: string | FormData; contentType: string | null };

/** JSON text with binary values replaced by `{ "$blob": i }`, plus the binary values. */
export function serialize(args: unknown): { json: string; blobs: Uint8Array[] } {
	const blobs: Uint8Array[] = [];
	const json = JSON.stringify(args, function (_key, value) {
		// JSON.stringify calls toJSON (Buffer) before the replacer; look at the raw holder value instead.
		const raw = (this as Record<string, unknown>)[_key];
		if (raw instanceof Uint8Array) {
			blobs.push(raw);
			return { $blob: blobs.length - 1 };
		}
		return value;
	});
	return { json, blobs };
}

/** The inverse of serialize. */
export function deserialize(json: string, blob: (index: number) => Uint8Array | undefined): unknown {
	return JSON.parse(json, (_key, value) => {
		if (value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 1 && typeof value.$blob === "number") {
			const data = blob(value.$blob);
			if (!data) throw new Error(`Missing binary part ${value.$blob}.`);
			return data;
		}
		return value;
	});
}

export function encodeArgs(args: unknown[]): Encoded {
	const { json, blobs } = serialize(args);
	if (!blobs.length) return { body: json, contentType: "application/json" };
	const form = new FormData();
	form.set("args", json);
	blobs.forEach((blob, index) => form.set(`blob-${index}`, new Blob([blob as Uint8Array<ArrayBuffer>]), `blob-${index}`));
	// fetch sets the multipart boundary itself.
	return { body: form, contentType: null };
}

const MAX_BLOBS = 4096;

export async function decodeArgs(request: Request): Promise<unknown> {
	const type = request.headers.get("content-type") ?? "";
	if (type.startsWith("application/json")) return JSON.parse(await request.text());
	if (!type.startsWith("multipart/form-data")) throw new Error("Expected application/json or multipart/form-data.");
	const form = await request.formData();
	const args = form.get("args");
	if (typeof args !== "string") throw new Error("Missing args part.");
	const blobs = new Map<number, Uint8Array>();
	for (const [name, value] of form.entries() as Iterable<[string, string | Blob]>) {
		const match = /^blob-(\d+)$/.exec(name);
		if (!match || typeof value === "string") continue;
		if (blobs.size >= MAX_BLOBS) throw new Error("Too many binary parts.");
		blobs.set(Number(match[1]), new Uint8Array(await value.arrayBuffer()));
	}
	return deserialize(args, (index) => blobs.get(index));
}
