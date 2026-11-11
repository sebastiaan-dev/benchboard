#!/bin/sh
# End-to-end check of benchmarking and profiling on Linux, as a benchmark runner would do it:
# build two versions of a small C program, measure both with Hyperfine, ingest, record samply
# profiles of both cases, and check the stored profiles. Run after deploy/linux-runner-setup.sh,
# as a regular user; needs a C compiler and git. Uses a temporary data directory unless BENCHBOARD_HOME/BENCHBOARD_SERVER is set.
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
[ -n "${BENCHBOARD_SERVER:-}" ] || export BENCHBOARD_HOME="${BENCHBOARD_HOME:-$work/data}"
cd "$work"
git init -q -b main repo && cd repo
git config user.name smoke && git config user.email smoke@example.com
sed 's/probe(60000000)/probe(PROBE)/; s/probe(30000000)/probe(PROBE \/ 2)/' "$root/packages/core/test/fixtures/samply-linux-threads.c" > work.c
printf '#define PROBE 60000000\n' > config.h && sed -i '1i #include "config.h"' work.c && git add . && git commit -qm "Initial engine"
git checkout -qb topic && printf '#define PROBE 30000000\n' > config.h && git commit -qam "Halve the probe work"
git checkout -q main && cc -O2 -g -fno-omit-frame-pointer -pthread -o base work.c
git checkout -q topic && cc -O2 -g -fno-omit-frame-pointer -pthread -o head work.c

benchboard profile check
hyperfine -N --runs 8 --warmup 1 --export-json q.json ./base ./head >/dev/null
printf '{"benchmark":"smoke/probe","cases":[{"case":"probe","commit":"main"},{"case":"probe","commit":"topic"}]}' > meta.json
benchboard ingest q.json --meta meta.json --track-branch --base main
run=$(benchboard runs --limit 1 | cut -f1)
benchboard run show latest
benchboard pr report topic | tee report.txt
grep -q "1 improvements" report.txt

benchboard profile record "$run:1" --iterations 2 2>&1 | grep -v "Running iteration\|two modules"
benchboard profile record "$run:2" --iterations 2 2>/dev/null | tee head.txt
head_id=$(sed -n 's/^Profile \([0-9]*\) .*/\1/p' head.txt)
benchboard profile show "$head_id" --limit 5 | tee show.txt
grep -q "waits not sampled" show.txt
grep -q "compare_keys" show.txt
benchboard profile diff "$((head_id - 1))" "$head_id" --limit 3 | tee diff.txt
grep -q "compare_keys" diff.txt
echo "linux profiling smoke test passed"
