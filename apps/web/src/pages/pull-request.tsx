import { useEffect, useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { ChevronDown, ChevronUp, ExternalLink, Flame, GitBranch, GitCommitHorizontal, GitPullRequest, Layers, RefreshCw, Search } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { CommitMatrix, type MatrixColumn, type MatrixRow } from "@/components/bench/commit-matrix";
import { TimelineChart } from "@/components/bench/timeline-chart";
import { ProfileDiffView } from "@/components/bench/profile-diff";
import { SeriesInspector, profilePairFor, scopedComparison, type Scope } from "@/components/bench/series-inspector";
import { EmptyState, ErrorState, LoadingState, NotFound } from "@/components/bench/states";
import { Crumbs, useRepositoryScope } from "@/components/shell";
import { MicroLabel, Panel, PanelHeader, Stat, StatStrip } from "@/components/kit/panel";
import { IntervalGlyph, Pill, SegmentedBar, Segmented, Sparkline, Ticks, verdictText, verdictVar, type Tick } from "@/components/kit/encodings";
import { useGraphQL, useGraphQLMutation } from "@/lib/graphql";
import { percentFromRatio, relativeTime, verdictLabel } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { PullRequestReportQuery as ReportResult, Statistic, Verdict } from "@/gql/graphql";
import { PullRequestReportQuery, SyncPullRequestMutation } from "./pull-request.queries";

export type Report = NonNullable<ReportResult["pullRequest"]>["report"];
export type Series = Report["series"][number];
type Filter = "all" | "changed" | "regressions" | "improvements" | "profiled";
type View = "list" | "matrix" | "chart";

// Columns collapse with the panel's width (container queries): trend and interval appear when there is room.
const ROW_GRID = "grid-cols-[minmax(7rem,1fr)_auto_4rem_1rem] @lg:grid-cols-[minmax(7rem,1fr)_auto_7rem_4rem_1rem] @2xl:grid-cols-[minmax(8rem,1fr)_auto_5.5rem_8rem_4rem_1rem]";

const value = (statistic: Statistic, m: { mean: number; median: number }) => statistic === "MEAN" ? m.mean : m.median;

export function seriesTicks(series: Series, columns: { position: number; label: string; subject: string }[]): Tick[] {
  return series.points.map((point, index) => {
    const isReference = series.reference?.position === point.position;
    const verdict = point.vsReference?.verdict;
    return {
      key: point.position,
      color: !point.measurement ? verdictVar.NONE : isReference ? "color-mix(in oklch, var(--foreground) 45%, transparent)" : verdict ? verdictVar[verdict] : verdictVar.NONE,
      // A step is attributed to this commit only when the previous commit was measured too.
      emphasis: !point.spansGap && (point.vsPrevious?.verdict === "REGRESSION" || point.vsPrevious?.verdict === "IMPROVEMENT"),
      label: (
        <div className="grid gap-0.5">
          <span className="font-mono">{columns[index].label}{point.measurement?.dirty ? " +dirty" : ""}</span>
          <span className="opacity-70">{columns[index].subject}</span>
          <span>{!point.measurement ? "not measured" : isReference ? "reference" : point.vsReference
            ? `${percentFromRatio(point.vsReference.ratio, 1)} vs reference · ${verdictLabel[point.vsReference.verdict].toLowerCase()}` : "measured"}</span>
          {point.vsPrevious && <span className="opacity-70">step {percentFromRatio(point.vsPrevious.ratio, 1)} since #{point.previousPosition}{point.spansGap ? " (spans unmeasured commits)" : ""}</span>}
        </div>
      ),
    };
  });
}

function SeriesRow({ series, columns, statistic, threshold, extent, selected, onSelect }: {
  series: Series; columns: { position: number; label: string; subject: string }[]; statistic: Statistic; threshold: number;
  extent: number; selected: boolean; onSelect: () => void;
}) {
  const comparison = series.headComparison;
  const values = series.points.map((point) => point.measurement ? value(statistic, point.measurement) : null);
  const reference = series.points.find((point) => point.position === series.reference?.position)?.measurement;
  const profiled = series.points.some((point) => point.measurement?.profiles.length);
  const color = comparison ? verdictVar[comparison.verdict] : "var(--muted-foreground)";
  return (
    <button
      type="button"
      onClick={onSelect}
      data-selected={selected}
      className={cn("group grid w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors", ROW_GRID,
        selected ? "bg-accent" : "hover:bg-accent/50")}
    >
      <span className="min-w-0">
        <span className="text-muted-foreground block truncate font-mono text-[11px]">{series.benchmark.key}</span>
        <span className="block truncate text-sm font-medium">{series.caseKey === "default" ? series.benchmark.title ?? series.label : series.caseKey}</span>
      </span>
      <Ticks ticks={seriesTicks(series, columns)} size="sm" />
      <span className="hidden @2xl:block"><Sparkline values={values} reference={reference ? value(statistic, reference) : undefined} color={color} width={88} height={22} /></span>
      <span className="hidden @lg:block">
        {comparison ? <IntervalGlyph ratio={comparison.ratio} low={comparison.low} high={comparison.high} verdict={comparison.verdict} threshold={threshold} extent={extent} width={112} />
          : <span className="text-muted-foreground font-mono text-[11px]">{series.head ? "single commit" : "head not measured"}</span>}
      </span>
      <span className="text-right font-mono text-sm font-medium tabular-nums" style={{ color: comparison ? verdictText(comparison.verdict) : undefined }}>
        {comparison ? percentFromRatio(comparison.ratio, 1)
          : series.latestComparison ? <span className="text-muted-foreground text-xs font-normal" title={`latest measured #${series.latest?.position}, not the head`}>({percentFromRatio(series.latestComparison.ratio, 0)})</span> : "—"}
      </span>
      {profiled ? <Flame className="size-3.5 text-orange-500" /> : <span />}
    </button>
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
    return report.series.filter((series) => {
      const verdict = series.verdict;
      if (filter === "regressions" && verdict !== "REGRESSION") return false;
      if (filter === "improvements" && verdict !== "IMPROVEMENT") return false;
      if (filter === "changed" && verdict !== "REGRESSION" && verdict !== "IMPROVEMENT") return false;
      if (filter === "profiled" && !series.points.some((point) => point.measurement?.profiles.length)) return false;
      if (commitFilter !== null) {
        const point = series.points.find((entry) => String(entry.position) === commitFilter);
        const step = point?.vsPrevious?.verdict;
        if (step !== "REGRESSION" && step !== "IMPROVEMENT") return false;
      }
      return !needle || `${series.benchmark.key} ${series.caseKey} ${series.label}`.toLowerCase().includes(needle);
    }).sort((a, b) => {
      // Regressions first, then by magnitude of change.
      const rank = (v: Verdict | null) => v === "REGRESSION" ? 0 : v === "FAILED" ? 1 : v === "INCONCLUSIVE" ? 2 : v === "IMPROVEMENT" ? 3 : 4;
      return rank(a.verdict) - rank(b.verdict) || Math.abs((b.headComparison?.ratio ?? 1) - 1) - Math.abs((a.headComparison?.ratio ?? 1) - 1);
    });
  }, [report, filter, search, commitFilter]);

  const selectedId = params.get("series") ?? visible[0]?.id ?? null;
  const selectedIndex = visible.findIndex((series) => series.id === selectedId);
  const selected = report?.series.find((series) => series.id === selectedId) ?? null;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement).closest("input, textarea, [role=combobox]")) return;
      if (event.key !== "j" && event.key !== "k" && event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
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
  const extent = Math.max(0.05, ...report.series.flatMap((series) => {
    const c = series.headComparison;
    return c ? [Math.abs((c.low ?? c.ratio) - 1), Math.abs((c.high ?? c.ratio) - 1)] : [];
  }));
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

      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
        <Segmented value={statistic} onChange={(entry) => update({ statistic: entry === "MEAN" ? "MEAN" : null })}
          options={[{ value: "MEDIAN", label: "Median" }, { value: "MEAN", label: "Mean" }]} />
        <div className="flex items-center gap-2">
          <MicroLabel>Threshold</MicroLabel>
          <Select value={String(threshold * 100)} onValueChange={(entry) => update({ threshold: entry === "2" ? null : entry })}>
            <SelectTrigger size="sm" className="w-20"><SelectValue /></SelectTrigger>
            <SelectContent>{["0.5", "1", "2", "3", "5", "10"].map((entry) => <SelectItem key={entry} value={entry}>±{entry}%</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-2">
          <MicroLabel>Machine</MicroLabel>
          <Select value={report.machine?.id ?? ""} onValueChange={(entry) => update({ machine: entry })} disabled={report.machines.length < 2}>
            <SelectTrigger size="sm" className="min-w-44"><SelectValue placeholder="No measurements" /></SelectTrigger>
            <SelectContent>
              {report.machines.map((entry) => (
                <SelectItem key={entry.machine.id} value={entry.machine.id}>{entry.machine.hostname} · {entry.machine.cpu} ({entry.count})</SelectItem>
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

      <Panel>
        <StatStrip className="sm:grid-cols-2 xl:grid-cols-[1.4fr_1fr_1fr_1fr]">
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
            tone={geomean === null ? undefined : geomean > 1 + threshold ? "bad" : geomean < 1 - threshold ? "good" : undefined}
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
          <Stat label="CPU profiles" value={profiles} detail={profiles ? "flame graphs per series" : "attach samply profiles to explain changes"} />
        </StatStrip>
      </Panel>

      {report.series.length === 0 ? (
        <EmptyState title="No measurements on this pull request yet">
          Ingest Hyperfine exports with <code>--commit</code> set to the base or PR commits, e.g.{" "}
          <code>benchboard ingest bench.json --benchmark tpch/sf1 --commit HEAD</code>.
        </EmptyState>
      ) : <>
        <Panel>
          <PanelHeader icon={GitCommitHorizontal} title="Commits" subtitle="Step changes vs the previous measured commit · click to filter series" />
          <div className="flex gap-1.5 overflow-x-auto px-4 pb-4">
            {columns.map((column, index) => {
              const active = commitFilter === String(column.position);
              const step = steps[index];
              return (
                <Tooltip key={column.position}>
                  <TooltipTrigger asChild>
                    <button type="button" onClick={() => update({ commit: active ? null : String(column.position), filter: null })}
                      disabled={!step.up && !step.down && !step.gap}
                      className={cn("bg-well grid min-w-28 flex-1 gap-1 rounded-xl border px-3 py-2 text-left transition-colors enabled:hover:border-foreground/25 disabled:opacity-70",
                        active && "border-foreground/40 bg-accent")}>
                      <span className="text-muted-foreground font-mono text-[10px] tracking-wide uppercase">{column.isBase ? "base" : `#${column.position}`}</span>
                      <span className="font-mono text-xs">{column.label === "base" ? column.sha.slice(0, 7) : column.label}</span>
                      <span className="flex h-4 items-center gap-2 font-mono text-[11px]">
                        {step.up > 0 && <span className="text-bad">▲ {step.up}</span>}
                        {step.down > 0 && <span className="text-good">▼ {step.down}</span>}
                        {step.gap > 0 && <span className="text-muted-foreground" title="changes across unmeasured commits">≈ {step.gap}</span>}
                        {!step.up && !step.down && !step.gap && <span className="text-muted-foreground/50">·</span>}
                      </span>
                    </button>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-xs">
                    <div className="font-medium">{column.subject || "(no subject)"}</div>
                    {column.author && <div className="opacity-70">{column.author}</div>}
                  </TooltipContent>
                </Tooltip>
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
                { value: "improvements", label: "Improvements" }, { value: "profiled", label: "Profiled" },
              ]} />
              <div className="relative ml-auto">
                <Search className="text-muted-foreground absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2" />
                <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Filter series" className="h-8 w-48 pl-8" />
              </div>
            </div>
            {view === "list" && (
              <div className="@container px-2 pb-2">
                <div className={cn("text-muted-foreground grid gap-3 px-3 pb-1.5 font-mono text-[10px] tracking-wide whitespace-nowrap uppercase", ROW_GRID)}>
                  <span>Series</span><span style={{ width: columns.length * 9 - 3 }}>Commits</span><span className="hidden @2xl:block">Trend</span>
                  <span className="hidden @lg:block">Head · 95% CI</span><span className="text-right">Δ head</span><span />
                </div>
                {visible.map((series) => (
                  <SeriesRow key={series.id} series={series} columns={columns} statistic={statistic} threshold={threshold} extent={extent}
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
                      isReference: series.reference?.position === point.position, vsReference: point.vsReference, vsPrevious: point.vsPrevious,
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

          <div className={cn("space-y-3", view === "list" && "xl:sticky xl:top-16 xl:max-h-[calc(100svh-5rem)] xl:overflow-y-auto xl:rounded-2xl")}>
            {selected ? (
              <SeriesInspector
                series={selected} report={report} statistic={statistic} threshold={threshold}
                position={selectedIndex >= 0 ? { index: selectedIndex, total: visible.length } : null}
                onPrevious={selectedIndex > 0 ? () => update({ series: visible[selectedIndex - 1].id }) : undefined}
                onNext={selectedIndex >= 0 && selectedIndex < visible.length - 1 ? () => update({ series: visible[selectedIndex + 1].id }) : undefined}
                scope={scope}
                onScopeChange={(next) => update({ scope: next.kind === "head" ? (commitFilter !== null ? "head" : null) : String(next.position) })}
                profilesAnchor={profilePair ? "#profile-diff" : undefined}
              />
            ) : <EmptyState title="Select a series" />}
          </div>
        </div>

        {selected && profilePair && (
          <div id="profile-diff" className="scroll-mt-16 space-y-2">
            {profilePair.fallback && <p className="text-muted-foreground text-xs">The compared baseline has no profile; using another profiled measurement at the same commit.</p>}
            <ProfileDiffView key={`${profilePair.base}:${profilePair.head}`} baseId={profilePair.base} headId={profilePair.head} inline />
          </div>
        )}
      </>}
      <p className="text-muted-foreground font-mono text-[11px]">
        <ChevronUp className="inline size-3" /><ChevronDown className="inline size-3" /> navigate series · regression: CI above 1 and change beyond the threshold ·
        improvement: CI below 1 and beyond the threshold · cross-run comparisons may include session drift · <Link className="underline" to={`/repositories/${pr.repository.id}/profiles`}>all profiles</Link>
      </p>
    </div>
  );
}
