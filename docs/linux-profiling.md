# Benchmarking and profiling on Linux (EC2)

Benchboard works the same on Linux hosts as on macOS: Hyperfine measures, samply profiles, and the
CLI uploads both to a server. This page covers what differs on Linux and how to set up a runner,
for example an EC2 instance.

## Quick setup

On a fresh instance (Amazon Linux 2023, Ubuntu, Debian, Fedora; x86_64 or arm64/Graviton):

```sh
curl -fsSL https://raw.githubusercontent.com/sebastiaan-dev/benchboard/main/deploy/linux-runner-setup.sh | sudo sh
benchboard login https://bench.example.com      # or export BENCHBOARD_SERVER and BENCHBOARD_TOKEN
benchboard profile check                        # as the user that runs benchmarks
```

[`deploy/linux-runner-setup.sh`](../deploy/linux-runner-setup.sh) installs:

* hyperfine and samply, pinned release binaries;
* Bun and the `benchboard` CLI;
* libc debug symbols.

It also sets `kernel.perf_event_paranoid = 1`, persisted in `/etc/sysctl.d/90-benchboard-perf.conf`.
It is idempotent and works as EC2 user data. It has been tested on Amazon Linux 2023, Ubuntu 24.04 and
Debian, on arm64.

After that, a run looks like it does on macOS:

```sh
hyperfine --export-json q1.json './build-main/duckdb -c "…"' './build-pr/duckdb -c "…"'
benchboard ingest q1.json --meta meta.json --pr 1234
benchboard profile record <run-id>:2 --iterations 5     # profiles case 2's command with samply
```

## What is different on Linux

**Permissions.** samply records with `perf_event_open`. Regular users need
`kernel.perf_event_paranoid` set to 1 or lower. Distributions default to 2 (Amazon Linux) or 4 (Debian,
Ubuntu). `benchboard profile check` reports the current value and the fix. `benchboard profile record`
refuses to start the workload until perf access works.

Inside containers the setting is host-wide, so set it on the host. The container also needs
`--cap-add PERFMON` (Linux 5.8+) or `--privileged`, and a seccomp profile that allows
`perf_event_open`.

**Only running threads are sampled.** On macOS, samply samples every thread at every tick, including
threads that are sleeping, blocked on a lock or waiting for I/O. On Linux (perf), samply only samples
threads that are running. Linux profiles therefore show **on-CPU time only**: a query that spends
most of its time waiting looks short in the profile but long in Hyperfine's wall-clock timings.

Benchboard detects this from the recording OS:

* The profile page and comparisons offer only the on-CPU view, labelled "On-CPU only · waits not sampled".
* `benchboard profile show --metric sampled` notes that sampled time equals on-CPU time.
* Comparing a Linux profile with a macOS one is flagged.

To find where wall time goes on Linux, compare on-CPU time with Hyperfine's wall-clock median, or use
off-CPU tooling such as `perf sched` or `offcputime` from bcc.

**Symbols.** Build the measured binaries with symbols and frame pointers, for example CMake
`RelWithDebInfo` plus `-fno-omit-frame-pointer`. Frame pointers give complete stacks. Without symbols,
frames show up as `fun_<address>` and count as unsymbolicated in the profile's "Symbolicated" figure.

libc frames need the distribution's debug symbols:

* Debian or Ubuntu: `libc6-dbg`.
* Amazon Linux, Fedora or RHEL: `dnf debuginfo-install glibc`.

Kernel frames are named only with `kernel.kptr_restrict = 0` (`KERNEL_SYMBOLS=1` for the setup script).

**Unknown frames on arm64.** On some arm64 kernels, the outermost return address of each stack still
carries pointer-authentication bits, so it falls outside every library. Benchboard folds such
addresses into a single `[unknown]` frame, so flame graphs and diffs are not split by them.

**`--iteration-count`.** On Linux every iteration is a separate process. samply may print "two
modules at the same start address" for each; this is harmless.

## Choosing and naming machines

Comparisons are only meaningful on comparable hardware, so the CLI records:

* the CPU model: on Graviton it is decoded from `/proc/cpuinfo`, e.g. "Arm Neoverse-V1 (Graviton3)";
* the EC2 instance type, read from DMI without calling the metadata service, e.g. "Amazon EC2 c7g.2xlarge".

The instance type shows next to the machine in reports. Set `BENCHBOARD_MACHINE_PLATFORM` to override it.

For stable numbers:

* **Avoid burstable instances** (`t3`, `t4g`, …). CPU credits make timings drift over the course of a
  run.
* **Prefer dedicated hardware for small effects.** Bare-metal (`*.metal`) or dedicated hosts remove
  noisy neighbours. Otherwise use compute-optimized instances of a fixed size.
* **Measure base and head in one Hyperfine invocation on the same instance.** Benchboard pairs cases
  from the same run. Comparisons across runs, and certainly across instances, are flagged as
  cross-invocation.
* **Ephemeral runners.** Machines are identified by hostname, and EC2 hostnames change with every
  instance. Set `BENCHBOARD_MACHINE`, for example `ci-c7g.2xlarge`, so every instance of a runner type
  is one machine in reports and history.

## CI on self-hosted runners

```yaml
# .github/workflows/bench.yml (excerpt), on a self-hosted EC2 runner prepared with linux-runner-setup.sh
env:
  BENCHBOARD_SERVER: https://bench.example.com
  BENCHBOARD_TOKEN: ${{ secrets.BENCHBOARD_TOKEN }}   # a write token: benchboard token create ci-runner
  BENCHBOARD_MACHINE: ci-c7g.2xlarge
steps:
  - run: |
      hyperfine --export-json q1.json "./base/bin q1" "./head/bin q1"
      run=$(benchboard ingest q1.json --meta meta.json --pr ${{ github.event.pull_request.number }} --json | jq -r .run.id)
      benchboard profile record "$run:2" --iterations 3
```

`GITHUB_TOKEN` or `GH_TOKEN` in the step environment lets the CLI read the pull request from GitHub.
