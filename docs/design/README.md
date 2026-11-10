# Benchboard design direction

References live in [`references/`](references/) (`index.json` lists the source posts; `sheet-*.jpg`
are contact sheets, `*-f<n>.jpg` frames extracted from videos, which are kept locally only).

## What the references have in common

* **Dark, quiet surfaces.** Near-black canvas, cards one step lighter with a hairline border, and
  *inset panels* (a darker well inside a card) for charts and key/value blocks
  (sinequanonh, disarto_max, yurygok). Light mode mirrors this with white cards on a grey canvas
  (malikyoloo, flohoeller).
* **Card anatomy.** Icon tile + title + one-line muted subtitle on the left, a segmented control or
  status pill on the right; dense body; optional footer bar with secondary text and actions
  (yurygok, disarto_max, turbodesignco).
* **Numbers first.** A hero number with a small delta pill ("+15.9%", "42s", "$13,590 ↑12.4%"),
  then micro labels in uppercase mono with wide tracking ("TOKENS SERVED / S", "VOICE TO VOICE").
  Monospace for values, SHAs, durations, timestamps; `·`-separated metadata lines.
* **Compact encodings over big charts.** Uptime-style tick rows (one pill per day/commit,
  malikyoloo, zzzzshawn), stacked proportion bars with a legend that doubles as a table
  (malikyoloo "Fleet status", flohoeller), waffle grids (kxshor, disarto_max), tiny sparklines,
  interval glyphs ("Uplift vs control · 95% intervals" in alibey_10), histograms with p50/p95/p99
  markers and a comparison series (alibey_10 "GET /api/orders latency").
* **Status color only where it matters.** Neutral greys carry structure; green/red/amber appear on
  dots, ticks and deltas, never as large fills.
* **Master–detail.** Lists on the left, a persistent inspector on the right with a key/value table
  and prev/next ("3 / 16") navigation instead of modal drill-downs (sinequanonh).
* **App shell.** Slim left sidebar (icon or labelled sections, workspace switcher at the top),
  breadcrumb + range/segmented controls in the page header (kxshor, sinequanonh).
* **Profiling visuals.** Rounded flame graph blocks with small gaps, trace waterfalls with inline
  duration bars (alibey_10).

## Applied to Benchboard

### Navigation: nothing more than one click deep

* Persistent sidebar: repository switcher; Overview, Pull requests, Benchmarks, Runs, Profiles;
  a *Tracked pull requests* section listing each PR with its regression/improvement counts.
* `⌘K` command palette to jump to any PR, benchmark, run or profile.
* Repository overview replaces the old repository page: PRs needing attention, recent runs and
  profiles, benchmark health.

### Pull request report

* Header with refs and the analysis controls (statistic, threshold, machine, dirty builds).
* A stat strip: verdict distribution (stacked bar + counts), head-vs-base geometric mean change,
  commits measured, profiles attached.
* Commit rail: one column per commit with its step regressions/improvements.
* **Series list ⇄ inspector.** Each series row shows: name, uptime-style ticks per commit colored by
  change vs reference, a sparkline, the head change with its 95% interval glyph, verdict and a
  profile marker. Selecting a row fills the inspector (no sheet): interval chart against the
  threshold band, per-commit trend with IQR band, base vs head sample histogram with medians,
  measurements, provenance, and, when profiles exist, the top function changes plus the
  differential flame graph inline below.
* The commit × series matrix remains as an alternate view of the list.

### Other pages

Runs, benchmarks and profiles adopt the same card anatomy, stat strips and inset panels; list pages
use dense tables with sparklines and ticks rather than nested navigation.
