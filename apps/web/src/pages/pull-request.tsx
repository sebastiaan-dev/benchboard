import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { ArrowLeftRight, ChevronDown, ChevronUp, Circle, ExternalLink, Terminal, Flame, GitBranch, GitCommitHorizontal, GitPullRequest, Layers, RefreshCw, Search } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { CommitMatrix, type MatrixColumn, type MatrixRow } from "@/components/bench/commit-matrix";
import { TimelineChart } from "@/components/bench/timeline-chart";
import { ProfileDiffView } from "@/components/bench/profile-diff";
import { SeriesInspector, profilePairFor, scopedComparison, type Scope } from "@/components/bench/series-inspector";
import { EmptyState, ErrorState, LoadingState, NotFound } from "@/components/bench/states";
import { Crumbs, TopBarActions, useRepositoryScope } from "@/components/shell";
import { Command } from "@/components/kit/onboarding";
import { MicroLabel, Panel, PanelHeader, Stat, StatStrip } from "@/components/kit/panel";
import { IntervalGlyph, Pill, SegmentedBar, Segmented, Sparkline, Ticks, verdictText, verdictVar, type Tick } from "@/components/kit/encodings";
import { useGraphQL, useGraphQLMutation } from "@/lib/graphql";
import { percentFromRatio, referenceName, relativeTime, verdictLabel } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { PullRequestReportQuery as ReportResult, Statistic, Verdict } from "@/gql/graphql";
import { PullRequestReportQuery, SyncPullRequestMutation } from "./pull-request.queries";

export type Report = NonNullable<ReportResult["pullRequest"]>["report"];
export type Series = Report["series"][number];
type Filter = "all" | "changed" | "regressions" | "improvements" | "profiled";
type View = "list" | "matrix" | "chart";

// Columns collapse with the panel's width (container queries): trend and interval appear when there is room.
const ROW_GRID = "grid-cols-[minmax(7rem,1fr)_auto_4rem_1rem] @md:grid-cols-[minmax(7rem,1fr)_auto_6rem_4rem_1rem] @xl:grid-cols-[minmax(8rem,1fr)_auto_5rem_7rem_4rem_1rem]";

const value = (statistic: Statistic, m: { mean: number; median: number }) => statistic === "MEAN" ? m.mean : m.median;

/** One tick per commit, colored by that commit's own step (vs the previous measured commit); the sparkline carries the cumulative trend. */
export function seriesTicks(series: Series, columns: { position: number; label: string; subject: string }[], selected: number | null = null): Tick[] {
  return series.points.map((point, index) => {
    const isReference = series.reference?.position === point.position;
    const step = point.vsPrevious?.verdict;
    const changed = step === "REGRESSION" || step === "IMPROVEMENT";
    const color = !point.measurement ? "color-mix(in oklch, var(--muted-foreground) 12%, transparent)"
      : isReference ? "color-mix(in oklch, var(--foreground) 55%, transparent)"
        : changed && !point.spansGap ? verdictVar[step]
          // Steps across unmeasured commits are not attributable to this commit: a muted tint only.
          : changed ? `color-mix(in oklch, ${verdictVar[step]} 40%, transparent)`
            : "color-mix(in oklch, var(--muted-foreground) 30%, transparent)";
    return {
      key: point.position,
      color,
      selected: selected === point.position,
      label: (
        <div className="grid gap-0.5">
          <span className="font-mono">{columns[index].label}{point.measurement?.dirty ? " +dirty" : ""}</span>
          <span className="opacity-70">{columns[index].subject}</span>
          {!point.measurement ? <span>not measured</span> : isReference ? <span>{series.referenceIsBase ? "base · changes are relative to this" : "first measured · changes are relative to this"}</span> : point.vsPrevious ? (
            <span>step {percentFromRatio(point.vsPrevious.ratio, 1)} vs {point.previousPosition === 0 ? "base" : `#${point.previousPosition}`} · {verdictLabel[point.vsPrevious.verdict].toLowerCase()}{point.spansGap ? " (spans unmeasured commits)" : ""}</span>
          ) : null}
          {point.vsReference && <span className="text-muted-foreground">{percentFromRatio(point.vsReference.ratio, 1)} vs {referenceName(series)}</span>}
        </div>
      ),
    };
  });
}

/** The comparison a row shows: head vs reference, or the selected commit's own step. */
function rowComparison(series: Series, focus: number | null) {
  if (focus === null) return series.headComparison;
  return series.points.find((point) => point.position === focus)?.vsPrevious ?? null;
}

function SeriesRow({ series, columns, statistic, threshold, extent, selected, onSelect, focus }: {
  series: Series; columns: { position: number; label: string; subject: string }[]; statistic: Statistic; threshold: number;
  extent: number; selected: boolean; onSelect: () => void; focus: number | null;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  // Keyboard navigation keeps the selected row visible.
  useEffect(() => { if (selected) ref.current?.scrollIntoView({ block: "nearest" }); }, [selected]);
  const comparison = rowComparison(series, focus);
  const values = series.points.map((point) => point.measurement ? value(statistic, point.measurement) : null);
  const reference = series.points.find((point) => point.position === series.reference?.position)?.measurement;
  const profiled = series.points.some((point) => point.measurement?.profiles.length);
  const trend = series.headComparison ? verdictVar[series.headComparison.verdict] : "var(--muted-foreground)";
  const empty = focus !== null ? "not measured here" : series.head ? "single commit" : "head not measured";
  return (
    <button
      ref={ref}
      type="button"
      onClick={onSelect}
      data-selected={selected}
      aria-current={selected ? "true" : undefined}
      className={cn("group grid w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/70", ROW_GRID,
        selected ? "bg-accent" : "hover:bg-accent/50")}
    >
      <span className="min-w-0">
        <span className="text-muted-foreground block truncate font-mono text-[11px]">{series.benchmark.key}</span>
        <span className="block truncate text-sm font-medium">{series.caseKey === "default" ? series.benchmark.title ?? series.label : series.caseKey}</span>
      </span>
      <Ticks ticks={seriesTicks(series, columns, focus)} size="sm" />
      <span className="hidden @xl:block"><Sparkline values={values} reference={reference ? value(statistic, reference) : undefined} color={trend} width={80} height={22} /></span>
      <span className="hidden @md:block">
        {comparison ? <IntervalGlyph ratio={comparison.ratio} low={comparison.low} high={comparison.high} verdict={comparison.verdict} threshold={threshold} extent={extent} width={112} />
          : <span className="text-muted-foreground font-mono text-[11px]">{empty}</span>}
      </span>
      <span className="flex items-center justify-end gap-1 text-right font-mono text-sm font-medium tabular-nums" style={{ color: comparison ? verdictText(comparison.verdict) : undefined }}>
        {comparison && !comparison.sameRun && (
          <span title="Sides come from separate Hyperfine invocations; repeat in reverse order before relying on it."
            className="text-muted-foreground"><ArrowLeftRight className="size-3" /></span>
        )}
        {comparison ? percentFromRatio(comparison.ratio, 1)
          : focus === null && series.latestComparison ? <span className="text-muted-foreground text-xs font-normal" title={`latest measured #${series.latest?.position}, not the head`}>({percentFromRatio(series.latestComparison.ratio, 0)})</span> : "—"}
      </span>
      {profiled ? <Flame className="size-3.5 text-orange-500" /> : <span />}
    </button>
  );
}

/**
 * One-sentence summary of the PR, in the spirit of the references' insight rows: the overall head
 * change and the commits that moved the most series, with whether those moves survive at the head.
 */
function Narrative({ report, columns, onSelect }: {
  report: Report; columns: { position: number; label: string; subject: string }[]; onSelect: (position: number) => void;
}) {
  const compared = report.series.filter((series) => series.headComparison && series.headComparison.low !== null);
  if (!compared.length) return null;
  const geomean = Math.exp(compared.reduce((sum, series) => sum + Math.log(series.headComparison!.ratio), 0) / compared.length);
  const name = (series: Series) => series.caseKey === "default" ? series.benchmark.key : series.caseKey;
  const byCommit = new Map<number, { up: Series[]; down: Series[] }>();
  for (const series of report.series) {
    for (const point of series.points) {
      const verdict = point.vsPrevious?.verdict;
      if (point.spansGap || (verdict !== "REGRESSION" && verdict !== "IMPROVEMENT")) continue;
      const entry = byCommit.get(point.position) ?? { up: [], down: [] };
      (verdict === "REGRESSION" ? entry.up : entry.down).push(series);
      byCommit.set(point.position, entry);
    }
  }
  const pick = (kind: "up" | "down") => [...byCommit].filter(([, entry]) => entry[kind].length)
    .sort((a, b) => b[1][kind].length - a[1][kind].length || a[0] - b[0])[0];
  const worst = pick("up");
  const best = pick("down");
  const commit = (position: number) => {
    const column = columns.find((entry) => entry.position === position);
    return (
      <button type="button" onClick={() => onSelect(position)} className="hover:text-foreground font-medium underline decoration-dotted underline-offset-4">
        #{position} {column?.label}{column?.subject ? ` “${column.subject.length > 48 ? `${column.subject.slice(0, 47)}…` : column.subject}”` : ""}
      </button>
    );
  };
  const regressedAtHead = (list: Series[]) => list.filter((series) => series.verdict === "REGRESSION").length;
  return (
    <p className="text-muted-foreground px-4 pb-3 text-sm leading-6">
      <span className="text-foreground">Head is {Math.abs((geomean - 1) * 100).toFixed(1)}% {geomean <= 1 ? "faster" : "slower"}</span> across {compared.length} series (geometric mean).
      {best && <> Biggest improvement: {commit(best[0])} sped up {best[1].down.length} series ({best[1].down.slice(0, 3).map(name).join(", ")}{best[1].down.length > 3 ? ", …" : ""}).</>}
      {worst && <> {commit(worst[0])} slowed {worst[1].up.length} series ({worst[1].up.slice(0, 3).map(name).join(", ")}{worst[1].up.length > 3 ? ", …" : ""}){
        regressedAtHead(worst[1].up) ? <span className="text-bad">; {regressedAtHead(worst[1].up)} still regressed at head</span> : "; none regressed at head"}.</>}
    </p>
  );
}

/** A PR without measurements: what to run for each commit, instead of an empty report. */
function MeasurePullRequest({ columns }: { columns: { position: number; label: string; subject: string; sha: string; isBase: boolean }[] }) {
  const base = columns.find((column) => column.isBase);
  const head = columns.at(-1);
  const meta = JSON.stringify({
    benchmark: "tpch/sf1",
    cases: [base, head].filter(Boolean).map((column) => ({ case: "q1", commit: column!.sha.slice(0, 12), dirty: false })),
  }, null, 2);
  return (
    <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
      <Panel>
        <PanelHeader icon={GitCommitHorizontal} title="No measurements yet" subtitle={`${columns.length} commits to measure · start with the base and the head`} />
        <div className="space-y-3 px-4 pb-4">
          {columns.map((column) => (
            <div key={column.position} className="grid grid-cols-[1.25rem_4.5rem_1fr] items-start gap-3">
              <Circle className="text-muted-foreground mt-1 size-3.5" />
              <span className="pt-0.5 font-mono text-xs">{column.isBase ? "base" : `#${column.position}`} {column.sha.slice(0, 7)}</span>
              <span className="text-muted-foreground truncate pt-0.5 text-xs">{column.subject}</span>
            </div>
          ))}
        </div>
      </Panel>
      <Panel>
        <PanelHeader icon={Terminal} title="Measure base and head together" subtitle="One Hyperfine invocation; each case is attributed to its commit" />
        <div className="space-y-3 px-4 pb-4 text-sm">
          <Command>{`hyperfine --export-json q1.json './build-${base?.sha.slice(0, 7) ?? "base"}/bin q1' './build-${head?.sha.slice(0, 7) ?? "head"}/bin q1'`}</Command>
          <p className="text-muted-foreground">with <code className="font-mono text-xs">meta.json</code> naming the series and commits in case order:</p>
          <Command>{meta}</Command>
          <Command>benchboard ingest q1.json --meta meta.json</Command>
          <p className="text-muted-foreground text-xs">Repeat with the commands in reverse order for results that decide a change, and add intermediate commits to find which one caused it.</p>
        </div>
      </Panel>
    </div>
  );
}

export function PullRequestPage() {
  const { id = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const statistic = (params.get("statistic") === "MEAN" ? "MEAN" : "MEDIAN") satisfies Statistic;
  const includeDirty = params.get("dirty") === "1";
  const threshold = Number(params.get("threshold") ?? 2) / 100;
  const machine = params.get("machine");
  const view = (params.get("view") ?? "list") as View;
  const filter = (params.get("filter") ?? "all") as Filter;
  const commitFilter = params.get("commit");
  const [search, setSearch] = useState("");
  const update = (changes: Record<string, string | null>) => setParams((current) => {
    const next = new URLSearchParams(current);
    for (const [key, entry] of Object.entries(changes)) entry === null ? next.delete(key) : next.set(key, entry);
    return next;
  }, { replace: true });

  const query = useGraphQL(PullRequestReportQuery, { id, statistic, includeDirty, machine, threshold }, { placeholderData: (previous) => previous });
  const sync = useGraphQLMutation(SyncPullRequestMutation);
  const pr = query.data?.pullRequest;
  const report = pr?.report;
  useRepositoryScope(pr?.repository.id);

  const columns = useMemo(() => report?.commits.map((entry) => ({
    position: entry.position, label: entry.isBase ? "base" : entry.commit.shortSha.slice(0, 7), subject: entry.commit.subject ?? "",
    author: entry.commit.author, isBase: entry.isBase, sha: entry.commit.sha, url: entry.commit.url,
  })) ?? [], [report]);

  const visible = useMemo(() => {
    if (!report) return [];
    const needle = search.trim().toLowerCase();
    const focus = commitFilter !== null ? Number(commitFilter) : null;
    return report.series.filter((series) => {
      // With a commit selected, verdict filters apply to that commit's step.
      const verdict = focus !== null ? rowComparison(series, focus)?.verdict ?? null : series.verdict;
      if (filter === "regressions" && verdict !== "REGRESSION") return false;
      if (filter === "improvements" && verdict !== "IMPROVEMENT") return false;
      if (filter === "changed" && verdict !== "REGRESSION" && verdict !== "IMPROVEMENT") return false;
      if (filter === "profiled" && !series.points.some((point) => point.measurement?.profiles.length)) return false;
      return !needle || `${series.benchmark.key} ${series.caseKey} ${series.label}`.toLowerCase().includes(needle);
    }).sort((a, b) => {
      // Regressions first, then by magnitude of change.
      const rank = (v: Verdict | null) => v === "REGRESSION" ? 0 : v === "FAILED" ? 1 : v === "INCONCLUSIVE" ? 2 : v === "IMPROVEMENT" ? 3 : 4;
      const ca = rowComparison(a, focus), cb = rowComparison(b, focus);
      return rank(ca?.verdict ?? null) - rank(cb?.verdict ?? null) || Math.abs((cb?.ratio ?? 1) - 1) - Math.abs((ca?.ratio ?? 1) - 1);
    });
  }, [report, filter, search, commitFilter]);

  const selectedId = params.get("series") ?? visible[0]?.id ?? null;
  const selectedIndex = visible.findIndex((series) => series.id === selectedId);
  const selected = report?.series.find((series) => series.id === selectedId) ?? null;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // Only plain keys that no focused control, open menu or dialog has handled move between series.
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement;
      if (target.closest("input, textarea, select, [contenteditable], [role=combobox], [role=listbox], [role=option], [role=menu], [role=menuitem], [role=dialog], [role=slider], [role=application]")) return;
      if (document.querySelector("[data-radix-popper-content-wrapper], [role=dialog][data-state=open], [role=listbox]")) return;
      if (event.key !== "j" && event.key !== "k" && event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      // Arrow keys keep scrolling the page unless focus is inside the series list; j/k work anywhere.
      if (event.key.startsWith("Arrow") && !target.closest("[data-series-list]")) return;
      const step = event.key === "j" || event.key === "ArrowDown" ? 1 : -1;
      const next = visible[Math.max(0, Math.min(visible.length - 1, selectedIndex + step))];
      if (next) { event.preventDefault(); update({ series: next.id }); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (query.isPending) return <LoadingState />;
  if (query.error && !pr) return <ErrorState error={query.error} />;
  if (!pr || !report) return <NotFound what="pull request" />;

  const s = report.summary;
  // Headline figures use only series measured at the head with an interval-backed comparison.
  const compared = report.series.filter((series) => series.headComparison && series.headComparison.low !== null);
  const geomean = compared.length ? Math.exp(compared.reduce((sum, series) => sum + Math.log(series.headComparison!.ratio), 0) / compared.length) : null;
  const focusPosition = commitFilter !== null ? Number(commitFilter) : null;
  // One axis for the list, clamped so a single large change does not shrink every interval to a dot.
  const shown = report.series.flatMap((series) => {
    const c = rowComparison(series, focusPosition);
    return c ? [Math.abs(c.ratio - 1)] : [];
  }).sort((a, b) => a - b);
  const p75 = shown.length ? shown[Math.min(shown.length - 1, Math.floor(shown.length * 0.75))] : 0;
  const extent = Math.max(3 * threshold, p75 * 1.25, 0.03);
  const measuredCommits = report.commits.filter((commit) => report.series.some((series) => series.points.find((point) => point.position === commit.position)?.measurement));
  const profiles = report.series.reduce((sum, series) => sum + series.points.reduce((n, point) => n + (point.measurement?.profiles.length ?? 0), 0), 0);
  const steps = columns.map((column) => {
    let up = 0, down = 0, gap = 0;
    for (const series of report.series) {
      const point = series.points.find((entry) => entry.position === column.position);
      const verdict = point?.vsPrevious?.verdict;
      if (verdict !== "REGRESSION" && verdict !== "IMPROVEMENT") continue;
      // Steps across unmeasured commits are shown separately: they are not attributable to this commit.
      if (point!.spansGap) gap++;
      else if (verdict === "REGRESSION") up++;
      else down++;
    }
    return { up, down, gap };
  });
  const prCommits = report.commits.filter((entry) => !entry.isBase).length;

  // The inspector explains one comparison: head vs reference, or a commit's step (defaults to the selected commit).
  const scopeParam = params.get("scope");
  const scope: Scope = scopeParam && scopeParam !== "head" ? { kind: "step", position: Number(scopeParam) }
    : !scopeParam && commitFilter !== null ? { kind: "step", position: Number(commitFilter) } : { kind: "head" };
  const scoped = selected ? scopedComparison(selected, scope) : null;
  const profilePair = selected && scoped ? profilePairFor(selected, scoped.comparison) : null;

  return (
    <div className="space-y-5">
      <Crumbs items={[
        { label: pr.repository.name, to: `/repositories/${pr.repository.id}` },
        { label: "Pull requests", to: `/repositories/${pr.repository.id}/pulls` },
        { label: pr.source === "GITHUB" ? `#${pr.number}` : pr.headRef },
      ]} />

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <span className="bg-card text-muted-foreground mt-0.5 flex size-10 shrink-0 items-center justify-center rounded-xl border">
            {pr.source === "GITHUB" ? <GitPullRequest className="size-5" /> : <GitBranch className="size-5" />}
          </span>
          <div className="min-w-0 space-y-1">
            <div className="flex items-center gap-2">
              <h1 className="truncate text-xl font-semibold tracking-tight">{pr.title}</h1>
              {pr.number !== null && <span className="text-muted-foreground text-xl font-light">#{pr.number}</span>}
              <Pill color={pr.state === "open" ? "var(--good)" : pr.state === "merged" ? "oklch(0.68 0.17 305)" : "var(--muted-foreground)"} className="capitalize">{pr.state}</Pill>
            </div>
            <p className="text-muted-foreground truncate font-mono text-xs">
              {pr.baseRef}@{pr.baseSha?.slice(0, 7) ?? "?"} ← {pr.headRef}@{pr.headSha.slice(0, 7)} · {prCommits} commits{pr.author ? ` · ${pr.author}` : ""} · synced {relativeTime(pr.syncedAt)}
            </p>
          </div>
        </div>
        <div className="flex gap-2">
          {pr.url && <Button variant="outline" size="sm" asChild><a href={pr.url} target="_blank" rel="noreferrer"><ExternalLink /> GitHub</a></Button>}
          <Button variant="outline" size="sm" disabled={sync.isPending} onClick={() => sync.mutate({ id: pr.id }, {
            onSuccess: () => toast.success("Pull request synced"), onError: (error) => toast.error(error.message),
          })}>
            <RefreshCw className={cn(sync.isPending && "animate-spin")} /> Sync
          </Button>
        </div>
      </div>

      {report.series.length > 0 && <TopBarActions>
      <div className="flex items-center gap-3">
        <Segmented value={statistic} onChange={(entry) => update({ statistic: entry === "MEAN" ? "MEAN" : null })}
          options={[{ value: "MEDIAN", label: "Median" }, { value: "MEAN", label: "Mean" }]} />
        <div className="flex items-center gap-2">
          <span className="sr-only">Threshold</span>
          <Select value={String(threshold * 100)} onValueChange={(entry) => update({ threshold: entry === "2" ? null : entry })}>
            <SelectTrigger size="sm" className="w-20" aria-label="Threshold"><SelectValue /></SelectTrigger>
            <SelectContent>{["0.5", "1", "2", "3", "5", "10"].map((entry) => <SelectItem key={entry} value={entry}>±{entry}%</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-2">
          <span className="sr-only">Machine</span>
          <Select value={report.machine?.id ?? ""} onValueChange={(entry) => update({ machine: entry })} disabled={report.machines.length < 2}>
            <SelectTrigger size="sm" className="max-w-56" aria-label="Machine"><SelectValue placeholder="No measurements" /></SelectTrigger>
            <SelectContent>
              {report.machines.map((entry) => (
                <SelectItem key={entry.machine.id} value={entry.machine.id}>{entry.machine.hostname} <span className="text-muted-foreground">· {entry.machine.cpu} · {entry.count}</span></SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-2">
          <Switch id="dirty" checked={includeDirty} onCheckedChange={(checked) => update({ dirty: checked ? "1" : null })} />
          <Label htmlFor="dirty" className="text-muted-foreground text-xs">Dirty builds</Label>
        </div>
        {query.isFetching && <RefreshCw className="text-muted-foreground size-3.5 animate-spin" />}
      </div>
      </TopBarActions>}

      {report.series.length > 0 && <Panel>
        <StatStrip className="sm:grid-cols-3 xl:grid-cols-[1.6fr_1fr_1fr]">
          <div>
            <div className="mb-3 flex items-center justify-between">
              <MicroLabel>Head vs {s.missingReference === s.series ? "first measurement" : "base"} · {s.series} series</MicroLabel>
              <span className="text-muted-foreground font-mono text-[11px]">±{(threshold * 100).toFixed(1)}% · 95% CI</span>
            </div>
            <SegmentedBar legend={false} segments={(["REGRESSION", "INCONCLUSIVE", "UNCHANGED", "IMPROVEMENT", "FAILED", "INSUFFICIENT", "NONE"] as const).map((verdict) => ({
              key: verdict, label: verdict === "NONE" ? "Head not measured" : verdictLabel[verdict], color: verdictVar[verdict],
              value: { REGRESSION: s.regressions, IMPROVEMENT: s.improvements, UNCHANGED: s.unchanged, INCONCLUSIVE: s.inconclusive,
                FAILED: s.failed, INSUFFICIENT: s.insufficient, NONE: s.missingHead }[verdict],
            }))} />
            <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1">
              {([["regressions", "REGRESSION", s.regressions], ["improvements", "IMPROVEMENT", s.improvements], ["unchanged", "UNCHANGED", s.unchanged],
                ["inconclusive", "INCONCLUSIVE", s.inconclusive], ["too few samples", "INSUFFICIENT", s.insufficient], ["head not measured", "NONE", s.missingHead]] as const)
                .filter(([key, , count]) => count > 0 || key === "regressions" || key === "improvements").map(([key, verdict, count]) => (
                <button key={key} type="button" onClick={() => update({ filter: filter === key ? null : key === "unchanged" || key === "inconclusive" ? null : key })}
                  className="flex items-center gap-1.5 text-sm">
                  <span className="size-2 rounded-full" style={{ background: verdictVar[verdict] }} />
                  <span className="font-semibold tabular-nums">{count}</span>
                  <span className="text-muted-foreground">{key}</span>
                </button>
              ))}
            </div>
          </div>
          <Stat label="Geometric mean change" value={geomean === null ? "—" : percentFromRatio(geomean, 1)}
            badge={geomean !== null && Math.abs(geomean - 1) > threshold ? <Pill color={geomean > 1 ? "var(--bad)" : "var(--good)"} className="h-5 text-[11px]">{geomean > 1 ? "slower" : "faster"}</Pill> : undefined}
            detail={`${compared.length} of ${s.series} with head intervals${s.crossRun ? ` · ${s.crossRun} cross-invocation` : ""}`} />
          <div>
            <Stat label="Commits measured" value={measuredCommits.length} unit={`/ ${report.commits.length}`}
              detail={[s.missingReference ? `${s.missingReference} lack a base` : "base included", s.missingHead ? `${s.missingHead} lack the head` : null].filter(Boolean).join(" · ")} />
            <Ticks className="mt-2" size="sm" ticks={report.commits.map((commit) => ({
              key: commit.position,
              color: measuredCommits.includes(commit) ? "var(--foreground)" : verdictVar.NONE,
              label: <span className="font-mono">{commit.isBase ? "base" : `#${commit.position}`} {commit.commit.shortSha.slice(0, 7)}</span>,
            }))} />
          </div>
        </StatStrip>
      </Panel>}

      {report.series.length === 0 ? (
        <MeasurePullRequest columns={columns} />
      ) : <>
        <Panel>
          <PanelHeader icon={GitCommitHorizontal} title="Commits" subtitle={commitFilter !== null ? "Showing each series' step at the selected commit · click it again to return to head vs base" : "Step changes vs the previous measured commit · select a commit to see what it changed"} />
          <Narrative report={report} columns={columns} onSelect={(position) => update({ commit: String(position), filter: null, scope: null })} />
          <div className="flex gap-1.5 overflow-x-auto px-4 pb-4">
            {columns.map((column, index) => {
              const active = commitFilter === String(column.position);
              const step = steps[index];
              const measured = measuredCommits.some((commit) => commit.position === column.position);
              return (
                <button key={column.position} type="button" onClick={() => update({ commit: active ? null : String(column.position), filter: null, scope: null })}
                  disabled={!measured || column.isBase} title={column.author ? `${column.subject}\n${column.author}` : column.subject}
                  className={cn("bg-well grid h-[76px] min-w-40 flex-1 content-start gap-1 rounded-xl border px-3 py-2 text-left transition-colors",
                    "enabled:hover:border-foreground/25 disabled:cursor-default outline-none focus-visible:ring-2 focus-visible:ring-ring/70",
                    !measured && "opacity-55", active && "border-foreground/40 bg-accent")}>
                  <span className="flex items-center gap-2">
                    <span className="text-muted-foreground font-mono text-[10.5px]">{column.isBase ? "base" : `#${column.position}`}</span>
                    <span className="font-mono text-xs">{column.sha.slice(0, 7)}</span>
                    <span className="ml-auto flex items-center gap-1.5 font-mono text-[11px]">
                      {step.up > 0 && <span className="text-bad">▲{step.up}</span>}
                      {step.down > 0 && <span className="text-good">▼{step.down}</span>}
                      {step.gap > 0 && <span className="text-muted-foreground" title="changes across unmeasured commits">≈{step.gap}</span>}
                    </span>
                  </span>
                  <span className="text-muted-foreground line-clamp-2 text-xs leading-4">{column.subject || "(no subject)"}</span>
                </button>
              );
            })}
          </div>
        </Panel>

        {/* The list sits beside its inspector; the wide matrix and chart views take the full width instead. */}
        <div className={cn("grid items-start gap-5", view === "list" && "xl:grid-cols-[minmax(0,1.1fr)_minmax(24rem,1fr)] 2xl:grid-cols-[minmax(0,1.25fr)_minmax(26rem,1fr)]")}>
          <Panel>
            <PanelHeader
              icon={Layers}
              title="Series"
              subtitle={`${visible.length} of ${report.series.length}${commitFilter !== null ? ` · changed at ${columns.find((c) => String(c.position) === commitFilter)?.label}` : ""} · ↑↓ or j/k to move`}
              actions={<Segmented value={view} onChange={(entry) => update({ view: entry === "list" ? null : entry })}
                options={[{ value: "list", label: "List" }, { value: "matrix", label: "Matrix" }, { value: "chart", label: "Chart" }]} />}
            />
            <div className="flex flex-wrap items-center gap-2 px-4 pb-3">
              <Segmented value={filter} onChange={(entry) => update({ filter: entry === "all" ? null : entry })} options={[
                { value: "all", label: "All" }, { value: "changed", label: "Changed" }, { value: "regressions", label: "Regressions" },
                { value: "improvements", label: "Improvements" }, { value: "profiled", label: profiles ? `Profiled · ${profiles}` : "Profiled" },
              ]} />
              <div className="relative ml-auto">
                <Search className="text-muted-foreground absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2" />
                <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Filter series" className="h-8 w-48 pl-8" />
              </div>
            </div>
            {view === "list" && (
              <div className="@container px-2 pb-2" data-series-list role="group" aria-label="Series">
                <div className={cn("text-muted-foreground grid gap-3 px-3 pb-1.5 text-xs whitespace-nowrap", ROW_GRID)}>
                  <span>Series</span><span style={{ width: columns.length * 9 - 3 }}>Commits</span><span className="hidden @xl:block">Trend</span>
                  <span className="hidden @md:block">{focusPosition !== null ? "Step · 95% CI" : "Head · 95% CI"}</span>
                  <span className="text-right">{focusPosition !== null ? `Δ at #${focusPosition}` : "Δ head"}</span><span />
                </div>
                {visible.map((series) => (
                  <SeriesRow key={series.id} series={series} columns={columns} statistic={statistic} threshold={threshold} extent={extent} focus={focusPosition}
                    selected={series.id === selectedId} onSelect={() => update({ series: series.id })} />
                ))}
                {!visible.length && <p className="text-muted-foreground px-3 py-8 text-center text-sm">No series match.</p>}
              </div>
            )}
            {view === "matrix" && (
              <div className="px-4 pb-4">
                <CommitMatrix
                  columns={columns.map<MatrixColumn>((column) => ({ ...column }))}
                  rows={visible.map<MatrixRow>((series) => ({
                    id: series.id, name: series.caseKey === "default" ? series.benchmark.key : `${series.benchmark.key} · ${series.caseKey}`,
                    detail: series.benchmark.title ?? series.label,
                    cells: series.points.map((point) => ({
                      value: point.measurement ? value(statistic, point.measurement) : null, dirty: point.measurement?.dirty ?? false,
                      isReference: series.reference?.position === point.position, referenceName: referenceName(series), vsReference: point.vsReference, vsPrevious: point.vsPrevious,
                      extra: Math.max(0, point.candidates.length - 1), profiled: (point.measurement?.profiles.length ?? 0) > 0,
                      spansGap: point.spansGap,
                    })),
                  }))}
                  onSelect={(series) => update({ series })}
                />
              </div>
            )}
            {view === "chart" && (
              <div className="px-4 pb-4">
                <TimelineChart
                  commits={columns.map((column) => ({ position: column.position, label: column.label, subject: column.subject }))}
                  series={visible.slice(0, 12).map((series) => ({
                    id: series.id, name: series.caseKey === "default" ? series.benchmark.key : `${series.benchmark.key} · ${series.caseKey}`,
                    ratios: series.points.map((point) => point.vsReference?.ratio ?? (series.reference?.position === point.position ? 1 : null)),
                  }))}
                />
              </div>
            )}
          </Panel>

          <div className={cn("space-y-3", view === "list" && "xl:sticky xl:top-16 xl:max-h-[calc(100svh-5rem)] xl:overflow-y-auto xl:rounded-2xl xl:[mask-image:linear-gradient(to_bottom,black_calc(100%-2rem),transparent)] xl:pb-6")}>
            {selected ? (
              <SeriesInspector
                series={selected} report={report} statistic={statistic} threshold={threshold}
                position={selectedIndex >= 0 ? { index: selectedIndex, total: visible.length } : null}
                onPrevious={selectedIndex > 0 ? () => update({ series: visible[selectedIndex - 1].id }) : undefined}
                onNext={selectedIndex >= 0 && selectedIndex < visible.length - 1 ? () => update({ series: visible[selectedIndex + 1].id }) : undefined}
                scope={scope}
                onScopeChange={(next) => update({ scope: next.kind === "head" ? (commitFilter !== null ? "head" : null) : String(next.position) })}
                profilePair={profilePair}
              />
            ) : <EmptyState title="Select a series" />}
          </div>
        </div>

        {selected && profilePair && (
          <div id="profile-diff" className="scroll-mt-16 space-y-2">
            <ProfileDiffView key={`${profilePair.base}:${profilePair.head}`} baseId={profilePair.base} headId={profilePair.head} inline />
          </div>
        )}
      </>}
      <p className="text-muted-foreground font-mono text-[11px]">
        <ChevronUp className="inline size-3" /><ChevronDown className="inline size-3" /> navigate series · regression: CI above 1 and change beyond the threshold ·
        improvement: CI below 1 and beyond the threshold · one Hyperfine invocation runs commands in blocks, so drift can remain; repeat in the reverse order for important results · <Link className="underline" to={`/repositories/${pr.repository.id}/profiles`}>all profiles</Link>
      </p>
    </div>
  );
}
