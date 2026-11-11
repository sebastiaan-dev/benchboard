# Benchboard

Track [Hyperfine](https://github.com/sharkdp/hyperfine) benchmarks across commits and pull requests,
attach [samply](https://github.com/mstange/samply) CPU profiles to explain them, query everything
with GraphQL, and inspect it in a web dashboard built with Vite, shadcn/ui and
[EvilCharts](https://evilcharts.com). Runs on [Bun](https://bun.sh).

```
hyperfine --export-json ─▶ benchboard ingest ─▶ SQLite + raw exports ─▶ GraphQL ─┬─▶ web app (PR reports)
                                    ▲                                            ├─▶ benchboard query / pr report
               gh / git ────────────┘ (PR and branch commits)                     └─▶ pi /bench
```

## Packages

| Path | Purpose |
| --- | --- |
| `packages/core` | Hyperfine validation, statistics, git/GitHub resolution, SQLite store (`bun:sqlite`), PR reports, samply profile aggregation, pi import |
| `packages/graphql` | `schema.graphql` (the API contract) and resolvers |
| `packages/cli` | `benchboard` CLI and the `Bun.serve` server (GraphQL, web app, Firefox Profiler endpoints) |
| `apps/web` | React app: shadcn/ui components, EvilCharts visualisations, GraphQL Codegen typed queries |

Bun runs the TypeScript sources directly; only the web app has a build step.

## Quick start

```sh
bun install
bun run build                               # web app → apps/web/dist
bun run seed:demo                           # synthetic PR with profiles in /tmp/benchboard-demo
BENCHBOARD_HOME=/tmp/benchboard-demo bun benchboard serve --open
```

For development, `bun run dev` runs the API server (port 4319, restarts on change) and Vite (port 5319,
proxying `/graphql` and profile endpoints). Set `BENCHBOARD_HOME` to point both at a data directory.

To put the CLI on `PATH`: `ln -s "$PWD/packages/cli/bin/benchboard.ts" ~/.local/bin/benchboard` (it runs with `bun`).

## Tracking a pull request

1. Track the PR (GitHub via `gh`) or a local branch (via `git`):

   ```sh
   benchboard pr track 1234                  # in a checkout; tries upstream, then origin
   benchboard pr track duckdb/duckdb#1234
   benchboard pr track --branch [--base upstream/main]
   ```

   The base is the parent of the PR's first commit (GitHub) or the closest merge base (local).

2. Measure the base and PR commits and attribute each case to a commit:

   ```sh
   hyperfine --export-json q1.json './base/duckdb -c "..."' './head/duckdb -c "..."'
   benchboard ingest q1.json --meta meta.json
   ```

   Measuring both commits in one Hyperfine invocation keeps machine conditions as similar as possible,
   but it does **not** interleave them: Hyperfine runs all iterations of one command, then the next
   (`A A A B B B`), so thermal, cache or background-load drift between the two blocks can still bias the
   ratio, and the bootstrap interval only reflects within-block noise. For important comparisons, repeat
   the invocation with the commands in the opposite order (`hyperfine … head base`) and ingest both
   runs; a change that is real survives both orders. The report shows which invocation each side came
   from and how many other measurements of the same commits it did not use.

   ```json
   {
     "benchmark": "tpch/sf1",
     "title": "TPC-H SF1 Q1",
     "conditions": "warm cache, 8 threads",
     "cases": [
       { "case": "q1", "commit": "upstream/main", "build": "reldebug" },
       { "case": "q1", "commit": "HEAD", "dirty": false, "build": "reldebug" }
     ]
   }
   ```

   `benchmark` + `case` identify a *series*; the same series at different commits forms one line in the
   PR report. Without explicit keys, a Hyperfine run whose cases are all different commits is a single
   series (`default`), `--parameter-scan` values become keys, and otherwise each command is its own
   series. Revisions are resolved in the checkout; omitted commits default to `HEAD` and are marked as
   inferred (with the working tree's dirty state).

3. Read the report:

   ```sh
   benchboard pr report 1234                 # terminal summary
   benchboard open pr 1234                   # web dashboard
   ```

The web app keeps everything one click away: a sidebar with the repository switcher, Overview, Pull
requests, Benchmarks, Runs, Profiles and every tracked PR with its regression/improvement counts, plus
a `⌘K` palette to jump to any PR, benchmark, run or profile.

The PR page is a master–detail view: a verdict summary and geometric-mean change, a commit rail with
step changes per commit (click to filter), and a series list where each row shows per-commit ticks,
a trend sparkline and the head change with its 95% interval. The inspector beside it shows the
interval against the threshold band, per-commit trend with IQR band, reference vs head sample
distributions, measurements and provenance; when profiles exist, the differential flame graph is
inline below. Matrix and chart views remain available. Settings live in the URL, so links are
shareable, and `j`/`k` move through series. See [docs/design](docs/design/README.md) for the visual
direction and its references.

## CPU profiles (samply)

Timings say *whether* a commit is slower; profiles say *where*. Record the measured command with
samply and attach the result to its case:

```sh
samply record --save-only --unstable-presymbolicate -o q1.json.gz ./build/release/duckdb -c "..."
benchboard profile attach <run-id>:2 q1.json.gz      # picks up q1.json.syms.json automatically
benchboard profile record <run-id>:2 [--iterations 5] [-- command...]   # or let benchboard run samply
```

or list them in the ingest metadata: `"cases": [{ "case": "q1", "commit": "HEAD", "profile": "q1.json.gz" }]`
(also `{ "file", "syms", "iterations", "label" }`, or an array).

Profiles are stored content-addressed under `$BENCHBOARD_HOME/profiles/`, and aggregated at ingest into
a call tree: samply's `.syms.json` sidecar symbolicates addresses (inlined frames expanded), threads
keep their own subtrees, and very large trees are pruned to their heaviest 250k nodes (samples are
folded into parents, so totals stay exact).

In the web app:

* **Profile page** — flame graph (zoom, search, per-thread or merged), hottest functions by self and
  total time, and *Open in Firefox Profiler*: profiler.firefox.com loads the raw profile from this
  server and symbolicates through its `/symbolicate/v5` endpoint, as with `samply load`
  (Chrome may ask to allow local network access).
* **Comparison** (`/profiles/compare?base=…&head=…`) — a differential flame graph merged by call path
  (red: more CPU time in head, blue: less) and per-function self/total changes in CPU ms per iteration.
* The PR matrix marks cells with profiles; a series' panel links straight to the reference → latest
  comparison.

In the terminal: `benchboard profile show <id>` and `benchboard profile diff <base> <head>` (`--metric cpu|sampled`).

Every view distinguishes two kinds of time, per iteration and summed over threads (so either can exceed wall time):

* **On-CPU** — from samply's per-sample thread CPU deltas. Sleeping, blocking on locks and waiting for I/O cost
  (almost) nothing here, so this answers "what burns CPU".
* **Sampled** — samples × interval, which includes those waits and answers "where does the time go". Profiles
  without CPU deltas fall back to it and are labelled *CPU (estimated)*.

Stored call trees are re-aggregated from the retained raw profiles when the aggregation changes.

## Statistics

* Statistics are recomputed from Hyperfine's raw samples; exports whose summaries disagree are rejected.
* Comparisons use the ratio of medians (or means) with a seeded percentile-bootstrap 95% interval.
* Verdicts (default threshold ±2%):
  * **regression** — CI entirely above 1 and the change exceeds the threshold;
  * **improvement** — CI entirely below 1 and the change exceeds the threshold;
  * **unchanged** — change within the threshold and CI within twice the threshold;
  * **inconclusive** — anything else (collect more samples, or reduce noise);
  * **insufficient** — fewer than 3 samples on a side: the ratio is shown, but no interval or verdict.
* Each series is compared with its measurement at the PR base, or its first measured commit. The
  *head* verdict needs a measurement at the PR head; otherwise the last measured commit is shown
  separately and not counted. Steps across unmeasured commits are marked and not attributed to one
  commit.
* Each commit's representative measurement (passing, clean, most recent) is the candidate of its
  comparisons; the baseline comes from the same Hyperfine invocation when the reference commit has an
  equally eligible measurement there. Every figure shown for a comparison comes from those two
  measurements. Comparisons between separate invocations are flagged.
* Comparisons never mix machines (default: the machine with the most measurements). Dirty builds are
  excluded unless requested, and clean measurements stay representative when both exist.

The bootstrap treats samples as independent and does not correct for multiple comparisons; use it
to rank evidence, not as a formal test.

## GraphQL

`benchboard serve` exposes `/graphql` (GraphiQL in the browser). The same schema runs in-process:

```sh
benchboard schema
benchboard query 'query ($id: ID!) {
  pullRequest(id: $id) {
    title
    report(statistic: MEDIAN, threshold: 0.02) {
      summary { regressions improvements }
      series { benchmark { key } caseKey latestComparison { changePercent low high verdict } }
    }
  }
}' --variables '{"id": "1"}'
```

The server binds to `127.0.0.1`, rejects other `Host` headers (DNS rebinding), sends no CORS
headers and refuses browser requests from other origins (`Origin` / `Sec-Fetch-Site`). Mutations
(sync or track PRs, delete runs or profiles) additionally require the per-process token that the web
app reads from the same-origin `/api/session`; `benchboard query` runs in-process and may mutate. For
Vite development, `BENCHBOARD_ALLOWED_ORIGINS=http://localhost:5319` is set by `bun run dev`.

Resolvers are typed from the schema (`packages/graphql/src/generated/resolvers.ts`, regenerated by
`bun run --filter @benchboard/graphql codegen` and on typecheck). Each request gets loaders that
batch and memoize nested lookups (run measurements and profiles, benchmark histories, machines,
commits); reports, comparisons and decompressed call trees are cached in the store until data changes.

## Data

`$BENCHBOARD_HOME` (default `~/.local/share/benchboard`) holds `benchboard.db` (SQLite, WAL) and
content-addressed raw exports in `exports/<sha256>.json`. Schema migrations are applied on open.
`benchboard import-legacy` imports pi's `/bench` history (`~/.pi/agent/benchmarks`) idempotently,
inferring commits from recorded revision notes.

## Checks

```sh
bun run check     # typecheck all packages, bun test suites, web build
bun run test:e2e  # browser smoke test: seeds the demo, serves it, renders every page in both themes
                  # and exercises commit scoping, mutations, shortcuts and keyboard flame graphs
```
