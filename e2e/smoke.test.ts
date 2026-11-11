/**
 * Browser smoke test: seeds the demo, serves the built web app and checks every page renders without
 * errors, plus the interactions that previously regressed. Needs a built web app (`bun run build`)
 * and Chrome for Testing from the Playwright cache (or CHROME=/path/to/chrome).
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright-core";

const root = path.resolve(import.meta.dir, "..");
const chrome = process.env.CHROME ?? (() => {
	const cache = path.join(os.homedir(), "Library/Caches/ms-playwright");
	if (!fs.existsSync(cache)) return undefined;
	for (const dir of fs.readdirSync(cache).filter((name) => name.startsWith("chromium-")).sort().reverse()) {
		const candidate = path.join(cache, dir, "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing");
		if (fs.existsSync(candidate)) return candidate;
	}
	return undefined;
})();
const ready = Boolean(chrome) && fs.existsSync(path.join(root, "apps/web/dist/index.html"));

let home: string;
let server: ReturnType<typeof spawn>;
let browser: Browser;
const port = 44000 + Math.floor(Math.random() * 1000);
const url = (route: string) => `http://localhost:${port}${route}`;

beforeAll(async () => {
	if (!ready) return;
	home = fs.mkdtempSync(path.join(os.tmpdir(), "benchboard-e2e-"));
	execFileSync("bun", ["scripts/seed-demo.ts"], { cwd: root, env: { ...process.env, BENCHBOARD_HOME: home }, stdio: "ignore" });
	server = spawn("bun", ["packages/cli/bin/benchboard.ts", "serve", "--port", String(port)], { cwd: root, env: { ...process.env, BENCHBOARD_HOME: home }, stdio: ["ignore", "ignore", "pipe"] });
	await new Promise<void>((resolve) => server.stderr!.on("data", (chunk: Buffer) => chunk.toString().includes("serving") && resolve()));
	browser = await chromium.launch({ executablePath: chrome });
}, 60_000);

afterAll(async () => {
	await browser?.close();
	server?.kill();
	if (home) fs.rmSync(home, { recursive: true, force: true });
});

async function open(route: string, theme = "dark"): Promise<{ page: Page; errors: string[] }> {
	const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
	await context.addInitScript((value) => localStorage.setItem("theme", value), theme);
	const page = await context.newPage();
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	page.on("console", (message) => message.type() === "error" && errors.push(message.text()));
	await page.goto(url(route), { waitUntil: "networkidle" });
	await page.waitForTimeout(500);
	return { page, errors };
}

test.skipIf(!ready)("every page renders without errors in both themes", async () => {
	const ids = JSON.parse(execFileSync("bun", ["packages/cli/bin/benchboard.ts", "query", "{ runs(limit: 1) { id } repositories { id benchmarks { id } profiles(limit: 2) { id } } }"],
		{ cwd: root, env: { ...process.env, BENCHBOARD_HOME: home }, encoding: "utf8" })).data;
	const repository = ids.repositories[0];
	const [head, base] = repository.profiles.map((profile: { id: string }) => profile.id);
	const routes = [
		"/", `/repositories/${repository.id}`, `/repositories/${repository.id}/pulls`, `/repositories/${repository.id}/benchmarks`,
		`/repositories/${repository.id}/runs`, `/repositories/${repository.id}/profiles`, "/pr/1", "/pr/1?view=matrix", "/pr/1?view=chart",
		`/runs/${ids.runs[0].id}`, `/benchmarks/${repository.benchmarks[0].id}`, `/profiles/${head}`, `/profiles/compare?base=${base}&head=${head}`,
	];
	for (const theme of ["dark", "light"]) {
		for (const route of routes) {
			const { page, errors } = await open(route, theme);
			assert.deepEqual(errors, [], `${theme} ${route}`);
			assert.ok((await page.locator("main").innerText()).length > 20, `${route} rendered content`);
			await page.context().close();
		}
	}
}, 120_000);

test.skipIf(!ready)("commit selection scopes the inspector; mutations carry the session token", async () => {
	const { page, errors } = await open("/pr/1");
	await page.locator('button:has-text("cb9f07c")').first().click();
	await page.waitForTimeout(500);
	assert.match(await page.locator("main").innerText(), /#5 vs #4/);
	await page.locator('button:has-text("Sync")').first().click();
	await page.locator("[data-sonner-toast]").first().waitFor();
	assert.match((await page.locator("[data-sonner-toast]").allInnerTexts()).join(" "), /synced/);
	assert.deepEqual(errors, []);
	await page.context().close();
}, 60_000);

test.skipIf(!ready)("series shortcuts ignore open dropdowns; flame graphs work from the keyboard", async () => {
	const { page } = await open("/pr/1");
	const selected = () => page.locator("[aria-current=true]").first().innerText();
	const before = await selected();
	await page.locator("button[role=combobox]").first().click();
	await page.keyboard.press("ArrowDown");
	await page.keyboard.press("Escape");
	assert.equal(await selected(), before);
	// With focus back on the page (not on a control), j moves to the next series.
	await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
	await page.keyboard.press("j");
	await page.waitForTimeout(300);
	assert.notEqual(await selected(), before);
	await page.context().close();

	const profile = await open("/profiles/1");
	await profile.page.locator("[role=application]").focus();
	for (const key of ["ArrowDown", "ArrowDown", "ArrowDown"]) await profile.page.keyboard.press(key);
	assert.match(await profile.page.locator("[aria-live=polite]").first().innerText(), /total .* self/);
	await profile.page.context().close();
}, 60_000);
