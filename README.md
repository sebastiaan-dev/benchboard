# Benchboard

Track [Hyperfine](https://github.com/sharkdp/hyperfine) benchmarks across commits and pull requests,
query them with GraphQL, and inspect them in a web dashboard built with Vite, shadcn/ui and
[EvilCharts](https://evilcharts.com).

```
hyperfine --export-json ─▶ benchboard ingest ─▶ SQLite + raw exports ─▶ GraphQL ─┬─▶ web app (PR reports)
                                    ▲                                            ├─▶ benchboard query / pr report
               gh / git ────────────┘ (PR and branch commits)                     └─▶ pi /bench
```

## Packages

| Path | Purpose |
| --- | --- |
| `packages/core` | Hyperfine validation, statistics, git/GitHub resolution, SQLite store, PR reports, pi import |
| `packages/graphql` | `schema.graphql` (the API contract) and resolvers |
| `packages/cli` | `benchboard` CLI and the HTTP server (GraphQL + built web app) |
| `apps/web` | React app: shadcn/ui components, EvilCharts visualisations, GraphQL Codegen typed queries |

Node 26 runs the TypeScript sources directly; only the web app has a build step.

## Quick start

```sh
pnpm install   # Node 26+, pnpm 12 (see package.json engines/packageManager)
pnpm build                                  # web app → apps/web/dist
pnpm seed:demo                              # synthetic PR in /tmp/benchboard-demo
BENCHBOARD_HOME=/tmp/benchboard-demo pnpm benchboard serve --open
```

For development, `pnpm dev` runs the API server (port 4319, restarts on change) and Vite (port 5319,
proxying `/graphql`). Set `BENCHBOARD_HOME` to point both at a data directory.

To put the CLI on `PATH`: `ln -s "$PWD/packages/cli/bin/benchboard.ts" ~/.local/bin/benchboard`.

## Tracking a pull request

1. Track the PR (GitHub via `gh`) or a local branch (via `git`):

   ```sh
   benchboard pr track 1234                  # in a checkout; tries upstream, then origin
   benchboard pr track duckdb/duckdb#1234
   benchboard pr track --branch [--base upstream/main]
   ```

   The base is the parent of the PR's first commit (GitHub) or the closest merge base (local).

2. Measure the base and PR commits, ideally interleaved in one Hyperfine invocation so session
   drift cancels out, and attribute each case to a commit:

   ```sh
   hyperfine --export-json q1.json './base/duckdb -c "..."' './head/duckdb -c "..."'
   benchboard ingest q1.json --meta meta.json
   ```

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

The PR page shows head-vs-base change per series with confidence intervals, every series' relative
change across commits, a commit × series matrix that highlights the commit introducing each step
change, and per-series drill-downs with raw samples and provenance. Settings live in the URL, so
links are shareable.

## Statistics

* Statistics are recomputed from Hyperfine's raw samples; exports whose summaries disagree are rejected.
* Comparisons use the ratio of medians (or means) with a seeded percentile-bootstrap 95% interval.
* Verdicts (default threshold ±2%):
  * **regression** — CI entirely above 1 and the change exceeds the threshold;
  * **improvement** — CI entirely below 1 and the change exceeds the threshold;
  * **unchanged** — change within the threshold and CI within twice the threshold;
  * **inconclusive** — anything else (collect more samples or measure in one run).
* Each series is compared with its measurement at the PR base, or its first measured commit.
  Pairs from the same Hyperfine run are preferred; cross-run comparisons are flagged.
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

The server binds to `127.0.0.1` and rejects other `Host` headers (DNS rebinding); mutations only
sync PR commits or delete runs.

## Data

`$BENCHBOARD_HOME` (default `~/.local/share/benchboard`) holds `benchboard.db` (SQLite, WAL) and
content-addressed raw exports in `exports/<sha256>.json`. Schema migrations are applied on open.
`benchboard import-legacy` imports pi's `/bench` history (`~/.pi/agent/benchmarks`) idempotently,
inferring commits from recorded revision notes.

## Checks

```sh
pnpm check     # typecheck all packages, node:test suites, web build
```
