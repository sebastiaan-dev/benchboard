# Real samply fixtures

Recorded on macOS arm64 with samply 0.13.1 (`samply record --save-only --unstable-presymbolicate`):

* `samply-python-sleep.json.gz` — Homebrew Python running `time.sleep(2)`: ~2 s sampled, ~25 ms on CPU.
* `samply-locks.json.gz` — `samply-locks.c` (`cc -O1 -g`): one thread computes while holding a mutex,
  a second blocks on it and then computes briefly, and the main thread sleeps in `pthread_join`.

Recorded on Linux arm64 (Debian 12 container, kernel 6.8, `kernel.perf_event_paranoid=1`) with samply 0.13.1:

* `samply-linux-threads.json.gz` — `samply-linux-threads.c` (`gcc -O2 -g -fno-omit-frame-pointer -pthread`): the
  main thread and two workers compute (`probe` → `compare_keys`) and then sleep 150 ms each. samply on Linux
  only samples running threads, so the sleeps leave no samples: sampled time equals on-CPU time. libc has no
  symbols here, so its frames are samply placeholders (`fun_<address>`).
* `samply-linux-pac.json.gz` — the same program on Amazon Linux 2023 arm64 (container, kernel 6.8), recorded by
  `benchboard profile record --iterations 3`. The outermost frame of every stack is a return address that still
  carries pointer-authentication bits, so it falls outside every module and differs per sample; such frames are
  collapsed into one `[unknown]` frame.

Hyperfine 2.0.0 exports (`schema_version: 2`, per-run measurements with units), recorded on Linux arm64:

* `hyperfine-2.0.0.json` — `hyperfine -N --runs 3 'sleep 0.01' 'sleep 0.02'`.
* `hyperfine-2.0.0-scan.json` — `hyperfine -N --runs 3 --parameter-scan n 1 2 'sleep 0.0{n}'`.
