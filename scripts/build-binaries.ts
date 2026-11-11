/**
 * Builds standalone `benchboard` executables (CLI and server, web app embedded) with `bun build --compile`.
 *
 *   bun run build                                  # the web app, once
 *   bun scripts/build-binaries.ts                  # this platform → dist/bin/benchboard-<os>-<arch>
 *   bun scripts/build-binaries.ts --all            # linux-x64, linux-arm64, darwin-x64, darwin-arm64
 *   bun scripts/build-binaries.ts --target bun-linux-arm64
 *
 * Writes SHA256SUMS next to the binaries. The version is the package version plus `git describe`.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { parseArgs } from "node:util";

const root = path.resolve(import.meta.dir, "..");
const { values } = parseArgs({
	options: { all: { type: "boolean" }, target: { type: "string", multiple: true }, out: { type: "string" } },
});
const ALL = ["bun-linux-x64", "bun-linux-arm64", "bun-darwin-x64", "bun-darwin-arm64"];
const host = `bun-${process.platform}-${process.arch}`;
const targets = values.all ? ALL : values.target?.length ? values.target : [host];
const out = path.resolve(values.out ?? path.join(root, "dist/bin"));

const dist = path.join(root, "apps/web/dist");
if (!fs.existsSync(path.join(dist, "index.html"))) throw new Error("Build the web app first: bun run build");

// A temporary entry that embeds every web app file (`with { type: "file" }`) and registers them.
fs.mkdirSync(path.join(root, "dist"), { recursive: true });
const work = fs.mkdtempSync(path.join(root, "dist/.build-"));
const files = (fs.readdirSync(dist, { recursive: true }) as string[])
	.filter((name) => fs.statSync(path.join(dist, name)).isFile()).sort();
const entry = path.join(work, "benchboard.ts");
fs.writeFileSync(entry, [
	...files.map((name, index) => `import f${index} from ${JSON.stringify(path.join(dist, name))} with { type: "file" };`),
	`import { useEmbeddedWebApp } from ${JSON.stringify(path.join(root, "packages/cli/src/server.ts"))};`,
	`import { main } from ${JSON.stringify(path.join(root, "packages/cli/src/main.ts"))};`,
	`useEmbeddedWebApp({ ${files.map((name, index) => `${JSON.stringify(`/${name.split(path.sep).join("/")}`)}: f${index}`).join(", ")} });`,
	"process.exitCode = await main(process.argv.slice(2));",
	"",
].join("\n"));

const pkg = JSON.parse(fs.readFileSync(path.join(root, "packages/cli/package.json"), "utf8")) as { version: string };
const describe = Bun.spawnSync(["git", "describe", "--tags", "--always", "--dirty"], { cwd: root }).stdout.toString().trim();
const version = describe && !describe.startsWith(`v${pkg.version}`) ? `${pkg.version}+${describe}` : describe.replace(/^v/, "") || pkg.version;

fs.mkdirSync(out, { recursive: true });
const sums: string[] = [];
try {
	for (const target of targets) {
		const name = `benchboard-${target.replace(/^bun-/, "")}`;
		const outfile = path.join(out, name);
		const build = Bun.spawnSync(["bun", "build", entry, "--compile", `--target=${target}`, "--minify", "--sourcemap",
			`--define=BENCHBOARD_VERSION=${JSON.stringify(version)}`, `--outfile=${outfile}`], { cwd: root, stdout: "pipe", stderr: "inherit" });
		if (build.exitCode !== 0) throw new Error(`bun build failed for ${target}`);
		const digest = new Bun.CryptoHasher("sha256").update(fs.readFileSync(outfile)).digest("hex");
		sums.push(`${digest}  ${name}`);
		console.log(`${name}  ${(fs.statSync(outfile).size / 1024 / 1024).toFixed(1)} MiB  ${version}`);
	}
} finally {
	fs.rmSync(work, { recursive: true, force: true });
}
fs.writeFileSync(path.join(out, "SHA256SUMS"), sums.join("\n") + "\n");
