# Real samply fixtures

Recorded on macOS arm64 with samply 0.13.1 (`samply record --save-only --unstable-presymbolicate`):

* `samply-python-sleep.json.gz` — Homebrew Python running `time.sleep(2)`: ~2 s sampled, ~25 ms on CPU.
* `samply-locks.json.gz` — `samply-locks.c` (`cc -O1 -g`): one thread computes while holding a mutex,
  a second blocks on it and then computes briefly, and the main thread sleeps in `pthread_join`.
