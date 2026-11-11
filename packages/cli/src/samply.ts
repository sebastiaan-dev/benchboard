/**
 * What samply needs on this machine, checked before recording so failures come with the fix.
 * macOS: `samply setup` (code-signing for task_for_pid). Linux: perf events, i.e.
 * `kernel.perf_event_paranoid` <= 1 for regular users, and CAP_PERFMON (or privileges) in containers.
 */
import * as fs from "node:fs";

export interface Check {
	name: string;
	ok: boolean | null;
	detail: string;
	fix?: string;
}

const read = (file: string) => {
	try { return fs.readFileSync(file, "utf8").trim(); } catch { return null; }
};

const INSTALL = "curl --proto '=https' --tlsv1.2 -LsSf https://github.com/mstange/samply/releases/latest/download/samply-installer.sh | sh   # or: cargo install --locked samply";

export function samplyChecks(): Check[] {
	const checks: Check[] = [];
	const binary = Bun.which("samply");
	const version = binary ? Bun.spawnSync([binary, "--version"]).stdout.toString().trim() : null;
	checks.push(binary
		? { name: "samply", ok: true, detail: `${version || "samply"} at ${binary}` }
		: { name: "samply", ok: false, detail: "not on PATH", fix: INSTALL });
	if (process.platform === "darwin") {
		checks.push({ name: "permissions", ok: null, detail: "macOS needs a one-time `samply setup` to attach to processes", fix: "samply setup" });
	}
	if (process.platform === "linux") {
		const root = process.getuid?.() === 0;
		const level = Number(read("/proc/sys/kernel/perf_event_paranoid"));
		const persist = "echo 'kernel.perf_event_paranoid = 1' | sudo tee /etc/sysctl.d/90-perf.conf && sudo sysctl --system";
		if (!Number.isFinite(level)) {
			checks.push({ name: "perf events", ok: false, detail: "/proc/sys/kernel/perf_event_paranoid is unreadable (not Linux, or /proc not mounted)" });
		} else if (level > 1 && !root) {
			checks.push({ name: "perf events", ok: false, detail: `kernel.perf_event_paranoid is ${level}; samply needs 1 or lower as a regular user`, fix: `sudo sysctl -w kernel.perf_event_paranoid=1   # persist: ${persist}` });
		} else {
			checks.push({ name: "perf events", ok: true, detail: `kernel.perf_event_paranoid is ${level}${root ? " (running as root)" : ""}` });
		}
		const kptr = read("/proc/sys/kernel/kptr_restrict");
		checks.push(kptr === "0"
			? { name: "kernel symbols", ok: true, detail: "kernel.kptr_restrict is 0: kernel frames are symbolicated" }
			: { name: "kernel symbols", ok: null, detail: `kernel.kptr_restrict is ${kptr ?? "unknown"}: kernel frames stay unnamed (user-space profiles are unaffected)`, fix: "sudo sysctl -w kernel.kptr_restrict=0" });
		if (fs.existsSync("/.dockerenv") || /docker|containerd|kubepods/.test(read("/proc/1/cgroup") ?? "")) {
			checks.push({ name: "container", ok: null, detail: "running in a container: perf_event_open needs CAP_PERFMON (Linux 5.8+) or --privileged, and a seccomp profile that allows it", fix: "docker run --cap-add PERFMON --security-opt seccomp=unconfined …" });
		}
		checks.push({ name: "waiting time", ok: null, detail: "samply on Linux samples running threads only: profiles show on-CPU time, not time spent blocked or sleeping" });
	}
	return checks;
}

/** The first blocking problem, phrased as an error with its fix. */
export function samplyProblem(): string | null {
	const failed = samplyChecks().find((check) => check.ok === false);
	return failed ? `${failed.name}: ${failed.detail}${failed.fix ? `\n  fix: ${failed.fix}` : ""}` : null;
}

/** Explains a failed `samply record`, by platform. */
export function samplyFailureHint(exitCode: number | null): string {
	const base = `samply exited with ${exitCode}`;
	if (process.platform === "darwin") return `${base}; if it could not attach, run \`samply setup\` once.`;
	if (process.platform === "linux") return `${base}; run \`benchboard profile check\` to see what perf access is missing.`;
	return `${base}.`;
}
