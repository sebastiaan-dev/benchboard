import { useState } from "react";
import { Link } from "react-router";
import { graphql } from "@/gql";
import { ChevronLeft, ChevronRight, Flame, GitCompare, LineChart } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { DistributionChart, TrendChart, type TrendPoint } from "@/components/bench/series-charts";
import { VerdictBadge } from "@/components/bench/states";
import { KeyValues, MicroLabel, Panel, PanelHeader, SectionLabel, Stat, StatStrip, Well } from "@/components/kit/panel";
import { Segmented, WideInterval, verdictText } from "@/components/kit/encodings";
import { useGraphQL } from "@/lib/graphql";
import { duration, percentFromRatio } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { Statistic } from "@/gql/graphql";
import type { Report, Series } from "@/pages/pull-request";
import { SeriesSamplesQuery } from "@/pages/pull-request.queries";

type Point = Series["points"][number];
export type Comparison = NonNullable<Point["vsReference"]>;

/** What the inspector explains: the PR as a whole, or one commit's step from the previous measured commit. */
export type Scope = { kind: "head" } | { kind: "step"; position: number };

export interface ScopedComparison {
  comparison: Comparison | null;
  /** Human labels for the two sides. */
  candidateLabel: string;
  baselineLabel: string;
  title: string;
  note: string | null;
}

const pointLabel = (point: Point | null | undefined) => !point ? "—" : point.isBase ? "base" : `#${point.position}`;

/** Resolves the scope to the single comparison whose measurements drive every figure shown. */
export function scopedComparison(series: Series, scope: Scope): ScopedComparison {
  const reference = series.points.find((point) => point.position === series.reference?.position);
  if (scope.kind === "step") {
    const point = series.points.find((entry) => entry.position === scope.position);
    const previous = series.points.find((entry) => entry.position === point?.previousPosition);
    if (!point?.measurement) return { comparison: null, candidateLabel: pointLabel(point), baselineLabel: "—", title: `${pointLabel(point)} step`, note: "Not measured at this commit." };
    if (!point.vsPrevious) return { comparison: null, candidateLabel: pointLabel(point), baselineLabel: "—", title: `${pointLabel(point)} step`, note: "This is the first measured commit; there is no previous step." };
    return {
      comparison: point.vsPrevious, candidateLabel: pointLabel(point), baselineLabel: pointLabel(previous),
      title: `${pointLabel(point)} vs ${pointLabel(previous)}`,
      note: point.spansGap ? `Spans ${point.position - (point.previousPosition ?? 0) - 1} unmeasured commit(s); the change is not attributable to ${pointLabel(point)} alone.` : null,
    };
  }
  const versus = series.referenceIsBase ? "base" : pointLabel(reference);
  if (series.head) {
    return { comparison: series.headComparison, candidateLabel: "head", baselineLabel: versus, title: `head vs ${versus}`, note: null };
  }
  const latest = series.points.find((point) => point.position === series.latest?.position);
  return {
    comparison: series.latestComparison, candidateLabel: pointLabel(latest), baselineLabel: versus,
    title: `latest measured ${pointLabel(latest)} vs ${versus}`,
    note: `The PR head was not measured; showing the last measured commit ${pointLabel(latest)}, which is not a head verdict.`,
  };
}

/** Profiles for the compared measurements; falls back to other measurements at the same commits, labelled as such. */
export function profilePairFor(series: Series, comparison: Comparison | null) {
  if (!comparison) return null;
  const head = comparison.candidate.profiles.at(0);
  let base = comparison.baseline.profiles.at(0);
  let fallback = false;
  if (!base) {
    const point = series.points.find((entry) => entry.measurement && entry.candidates.some((candidate) => candidate.id === comparison.baseline.id));
    base = point?.measurement?.profiles[0];
    fallback = Boolean(base);
  }
  return head && base && head.id !== base.id ? { base: base.id, head: head.id, fallback } : null;
}

function Change({ comparison }: { comparison: Point["vsReference"] }) {
  if (!comparison) return <span className="text-muted-foreground/60">—</span>;
  return (
    <span className="font-mono tabular-nums" style={{ color: verdictText(comparison.verdict) }}
      title={comparison.low === null ? "too few samples for an interval" : `95% CI ${percentFromRatio(comparison.low, 2)} … ${percentFromRatio(comparison.high, 2)}${comparison.sameRun ? "" : " (cross-invocation)"}`}>
      {percentFromRatio(comparison.ratio, 1)}
    </span>
  );
}

/** Persistent detail panel for one series and one comparison scope. */
type Tab = "summary" | "samples" | "measurements" | "provenance";

/** Top function changes for the compared profiles, computed on the server. */
const TopChangesQuery = graphql(`
  query InspectorTopChanges($base: ID!, $head: ID!) {
    profileDiff(base: $base, head: $head, limit: 3) { baseMs headMs functions { name deltaSelfMs baseSelfMs headSelfMs } }
  }
`);

function TopChanges({ pair, anchor }: { pair: { base: string; head: string; fallback: boolean }; anchor: string }) {
  const query = useGraphQL(TopChangesQuery, { base: pair.base, head: pair.head });
  const diff = query.data?.profileDiff;
  const max = Math.max(1e-9, ...(diff?.functions ?? []).map((entry) => Math.abs(entry.deltaSelfMs)));
  return (
    <section className="space-y-2">
      <div className="flex items-center gap-2 px-1">
        <Flame className="size-3.5 text-orange-500" />
        <SectionLabel>Where the time went · on-CPU per iteration</SectionLabel>
        <Button size="sm" variant="ghost" className="ml-auto h-7" asChild><a href={anchor}><GitCompare /> Flame graph</a></Button>
      </div>
      <Well className="divide-y overflow-hidden">
        {!diff ? <Skeleton className="h-24" /> : <>
          <div className="text-muted-foreground flex justify-between px-3 py-1.5 font-mono text-[11px]">
            <span>total {duration(diff.baseMs / 1000)} → {duration(diff.headMs / 1000)}</span>
            <span>{percentFromRatio(diff.baseMs ? diff.headMs / diff.baseMs : 1, 1)}</span>
          </div>
          {diff.functions.map((entry) => (
            <div key={entry.name} className="grid grid-cols-[4.5rem_4rem_minmax(0,1fr)] items-center gap-3 px-3 py-1.5 text-xs">
              <span className={cn("text-right font-mono tabular-nums", entry.deltaSelfMs > 0 ? "text-bad" : "text-info")}>
                {entry.deltaSelfMs >= 0 ? "+" : ""}{entry.deltaSelfMs.toFixed(Math.abs(entry.deltaSelfMs) >= 10 ? 1 : 2)} ms
              </span>
              <span className="bg-muted relative h-1.5 overflow-hidden rounded-full">
                <span className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${(Math.abs(entry.deltaSelfMs) / max) * 100}%`, background: entry.deltaSelfMs > 0 ? "var(--bad)" : "var(--info)" }} />
              </span>
              <span className="truncate font-mono" title={entry.name}>{entry.name}</span>
            </div>
          ))}
        </>}
      </Well>
      {pair.fallback && <p className="text-muted-foreground px-1 text-[11px]">The compared baseline has no profile; using another profiled measurement at the same commit.</p>}
    </section>
  );
}

export function SeriesInspector({ series, report, statistic, threshold, scope, onScopeChange, position, onPrevious, onNext, profilePair }: {
  series: Series; report: Report; statistic: Statistic; threshold: number; scope: Scope; onScopeChange: (scope: Scope) => void;
  position: { index: number; total: number } | null; onPrevious?: () => void; onNext?: () => void;
  profilePair: { base: string; head: string; fallback: boolean } | null;
}) {
  const [tab, setTab] = useState<Tab>("summary");
  const scoped = scopedComparison(series, scope);
  const comparison = scoped.comparison;
  const ids = comparison ? [...new Set([comparison.baseline.id, comparison.candidate.id])] : [];
  const samples = useGraphQL(SeriesSamplesQuery, { ids }, { enabled: ids.length > 0 });
  const byId = new Map(samples.data?.measurements.map((measurement) => [measurement.id, measurement]));
  const pick = (m: { mean: number; median: number }) => statistic === "MEAN" ? m.mean : m.median;
  const columns = report.commits.map((entry) => entry.isBase ? "base" : entry.commit.shortSha.slice(0, 7));
  const reference = series.points.find((point) => point.position === series.reference?.position);
  const trend: TrendPoint[] = series.points.map((point, index) => {
    const m = point.measurement;
    return {
      position: point.position, label: columns[index], subject: report.commits[index].commit.subject ?? "",
      value: m ? pick(m) : null, q1: m?.q1 ?? null, q3: m?.q3 ?? null, min: m?.min ?? null, max: m?.max ?? null, n: m?.n ?? null, dirty: m?.dirty ?? false,
    };
  });
  const extent = Math.max(0.05, comparison?.low != null && comparison.high != null
    ? Math.max(Math.abs(comparison.low - 1), Math.abs(comparison.high - 1)) * 1.3 : comparison ? Math.abs(comparison.ratio - 1) * 1.3 : 0.05);
  const candidateDetail = comparison ? byId.get(comparison.candidate.id) : undefined;
  const latestProfile = [...series.points].reverse().find((point) => point.measurement?.profiles.length)?.measurement?.profiles[0];
  const name = series.caseKey === "default" ? series.benchmark.key : `${series.benchmark.key} · ${series.caseKey}`;
  const steps = series.points.filter((point) => point.vsPrevious);
  const sideStat = (label: string, m: Comparison["candidate"] | undefined) => (
    <Stat label={label} value={m ? duration(pick(m)) : "—"} className="[&_div:nth-child(2)]:text-lg"
      detail={m ? `n=${m.n}${m.cv !== null ? ` · cv ${(m.cv * 100).toFixed(1)}%` : ""}${m.dirty ? " · dirty" : ""}` : undefined} />
  );

  return (
    <Panel>
      <PanelHeader
        icon={LineChart}
        title={name}
        subtitle={series.benchmark.title ?? series.label}
        actions={<>
          {position && (
            <span className="text-muted-foreground flex items-center font-mono text-[11px]">
              <Button variant="ghost" size="icon" className="size-7" disabled={!onPrevious} onClick={onPrevious} aria-label="Previous series"><ChevronLeft /></Button>
              {position.index + 1} / {position.total}
              <Button variant="ghost" size="icon" className="size-7" disabled={!onNext} onClick={onNext} aria-label="Next series"><ChevronRight /></Button>
            </span>
          )}
        </>}
      />
      <div className="space-y-4 px-4 pb-4">
        <div className="flex flex-wrap items-center gap-2">
          <Segmented
            value={scope.kind}
            onChange={(entry) => onScopeChange(entry === "head" ? { kind: "head" } : { kind: "step", position: steps.at(-1)?.position ?? 0 })}
            options={[
              { value: "head", label: series.head ? "Head vs reference" : "Latest vs reference" },
              ...(steps.length ? [{ value: "step" as const, label: "Commit step" }] : []),
            ]}
          />
          {scope.kind === "step" && (
            <Select value={String(scope.position)} onValueChange={(entry) => onScopeChange({ kind: "step", position: Number(entry) })}>
              <SelectTrigger size="sm" className="min-w-40"><SelectValue /></SelectTrigger>
              <SelectContent>
                {steps.map((point) => (
                  <SelectItem key={point.position} value={String(point.position)}>
                    {pointLabel(point)} vs #{point.previousPosition === 0 ? "base" : point.previousPosition} · {percentFromRatio(point.vsPrevious!.ratio, 1)}{point.spansGap ? " · spans gap" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>

        <Well className="p-4">
          <MicroLabel>{statistic === "MEAN" ? "Mean" : "Median"} · {scoped.title}</MicroLabel>
          <div className="mt-1 flex items-center gap-3">
            <span className="text-3xl font-medium tracking-tight tabular-nums">{comparison ? percentFromRatio(comparison.ratio, 2) : "—"}</span>
            {comparison && <VerdictBadge verdict={comparison.verdict} />}
          </div>
          <div className="text-muted-foreground mt-1 font-mono text-[11px]">
            {!comparison ? scoped.note ?? "only one commit measured"
              : comparison.low === null ? `no interval: ${Math.min(comparison.candidate.n, comparison.baseline.n)} sample(s) on a side · descriptive only`
                : <>95% CI {percentFromRatio(comparison.low, 2)} … {percentFromRatio(comparison.high, 2)} · {comparison.resamples} resamples</>}
            {comparison && <> · {comparison.pairing === "SAME_INVOCATION" ? "same Hyperfine invocation" : "separate invocations"}{comparison.alternatives ? ` · ${comparison.alternatives} other measurement${comparison.alternatives > 1 ? "s" : ""} not used` : ""}</>}
          </div>
          {comparison && scoped.note && <p className="text-warn mt-2 text-xs">{scoped.note}</p>}
          {comparison && (
            <div className="mt-4">
              <WideInterval ratio={comparison.ratio} low={comparison.low} high={comparison.high} verdict={comparison.verdict} threshold={threshold} extent={extent} height={22} />
              <div className="text-muted-foreground mt-1 flex justify-between font-mono text-[10px]">
                <span>{percentFromRatio(1 - extent, 0)}</span><span>±{(threshold * 100).toFixed(1)}% threshold</span><span>{percentFromRatio(1 + extent, 0)}</span>
              </div>
            </div>
          )}
        </Well>

        {comparison && (
          <StatStrip className="bg-well grid-cols-2 rounded-xl border sm:grid-cols-3 [&>*]:px-3 [&>*]:py-3">
            {sideStat(scoped.baselineLabel === "base" ? "Base" : `Before · ${scoped.baselineLabel}`, comparison.baseline)}
            {sideStat(scoped.candidateLabel === "head" ? "Head" : `After · ${scoped.candidateLabel}`, comparison.candidate)}
            <div className="min-w-0">
              <MicroLabel>Compared runs</MicroLabel>
              <div className="mt-1.5 grid gap-1 text-xs">
                <Link to={`/runs/${comparison.baseline.run.id}`} className="hover:text-foreground text-muted-foreground truncate">{scoped.baselineLabel} · {comparison.baseline.run.title ?? comparison.baseline.run.id}</Link>
                <Link to={`/runs/${comparison.candidate.run.id}`} className="hover:text-foreground text-muted-foreground truncate">{scoped.candidateLabel} · {comparison.candidate.run.title ?? comparison.candidate.run.id}</Link>
              </div>
            </div>
          </StatStrip>
        )}

        <div className="-mx-4 border-b px-4">
          <div role="tablist" aria-label="Series details" className="flex gap-4">
            {(["summary", "samples", "measurements", "provenance"] as const).map((entry) => (
              <button key={entry} type="button" role="tab" aria-selected={tab === entry} onClick={() => setTab(entry)}
                className={cn("-mb-px border-b-2 py-2 text-xs font-medium capitalize transition-colors outline-none focus-visible:text-foreground",
                  tab === entry ? "border-foreground text-foreground" : "text-muted-foreground hover:text-foreground border-transparent")}>
                {entry}
              </button>
            ))}
          </div>
        </div>

        {tab === "summary" && profilePair && <TopChanges pair={profilePair} anchor="#profile-diff" />}
        {tab === "summary" && !profilePair && latestProfile && (
          <div className="text-muted-foreground flex items-center gap-2 px-1 text-xs">
            <Flame className="size-3.5 text-orange-500" /> No profiles for the compared measurements ·
            <Link to={`/profiles/${latestProfile.id}`} className="hover:text-foreground underline underline-offset-4">latest profile of this series</Link>
          </div>
        )}

        {tab === "summary" && <section className="space-y-2">
          <SectionLabel>Per commit · representative measurements</SectionLabel>
          <Well className="px-1 pt-3 pb-1">
            <TrendChart points={trend} reference={reference?.measurement ? pick(reference.measurement) : null} statistic={statistic === "MEAN" ? "Mean" : "Median"}
              highlight={scope.kind === "step" ? columns[report.commits.findIndex((entry) => entry.position === scope.position)] : undefined}
              steps={series.points.flatMap((point, index) => !point.spansGap && (point.vsPrevious?.verdict === "REGRESSION" || point.vsPrevious?.verdict === "IMPROVEMENT")
                ? [{ label: columns[index], regression: point.vsPrevious.verdict === "REGRESSION" }] : [])} />
          </Well>
        </section>}

        {tab === "samples" && !(comparison && comparison.baseline.id !== comparison.candidate.id) && (
          <p className="text-muted-foreground px-1 text-sm">Select a comparison with two measurements to see their sample distributions.</p>
        )}
        {tab === "samples" && comparison && comparison.baseline.id !== comparison.candidate.id && (
          <section className="space-y-2">
            <SectionLabel>Sample distribution · {scoped.baselineLabel} vs {scoped.candidateLabel}</SectionLabel>
            <Well className="px-1 pt-3 pb-1">
              {samples.isPending ? <Skeleton className="h-48" /> : (
                <DistributionChart base={byId.get(comparison.baseline.id)?.times ?? []} head={byId.get(comparison.candidate.id)?.times ?? []}
                  labels={{ base: scoped.baselineLabel, head: scoped.candidateLabel }} />
              )}
            </Well>
          </section>
        )}

        {tab === "measurements" && <section className="space-y-2">
          <SectionLabel count={series.points.filter((point) => point.measurement).length}>Measurements</SectionLabel>
          <Well className="divide-y overflow-hidden">
            {series.points.map((point, index) => {
              const m = point.measurement;
              const inScope = comparison && m && (m.id === comparison.candidate.id || point.candidates.some((c) => c.id === comparison.baseline.id));
              return (
                <button type="button" key={point.position} disabled={!point.vsPrevious}
                  onClick={() => onScopeChange({ kind: "step", position: point.position })}
                  className={cn("grid w-full grid-cols-[4.5rem_1fr_5rem_3.5rem_3.5rem_1rem] items-center gap-2 px-3 py-1.5 text-left text-xs enabled:hover:bg-accent/50",
                    !m && "opacity-45", inScope && "bg-accent/60")}>
                  <span className="font-mono">{columns[index]}{m?.dirty ? "*" : ""}</span>
                  <span className="text-muted-foreground truncate">{m ? m.run.title ?? m.run.id : report.commits[index].commit.subject}</span>
                  <span className="text-right font-mono tabular-nums">{m ? duration(pick(m)) : "—"}</span>
                  <span className="text-right">{point.position === series.reference?.position ? <span className="text-muted-foreground font-mono">ref</span> : <Change comparison={point.vsReference} />}</span>
                  <span className="text-right"><Change comparison={point.vsPrevious} />{point.spansGap && <span className="text-muted-foreground">*</span>}</span>
                  {m?.profiles.length ? <Flame className="size-3.5 text-orange-500" /> : <span />}
                </button>
              );
            })}
          </Well>
          <p className="text-muted-foreground font-mono text-[10.5px]">value · vs reference · vs previous measured (* spans unmeasured commits) · click a row to inspect its step</p>
        </section>}

        {tab === "provenance" && candidateDetail && (
          <section className="space-y-2">
            <SectionLabel>Provenance · candidate {scoped.candidateLabel}</SectionLabel>
            <KeyValues rows={[
              ["command", candidateDetail.command ?? candidateDetail.exportedCommand],
              ["build", candidateDetail.build],
              ["commit", <>{candidateDetail.commitSha?.slice(0, 12)}{candidateDetail.commitInferred ? <span className="text-muted-foreground"> // inferred</span> : null}</>],
              ["machine", `${candidateDetail.run.machine.hostname} · ${candidateDetail.run.machine.cpu}`],
              ["conditions", candidateDetail.run.conditions],
              ["environment", candidateDetail.run.environment],
            ]} />
            <div className="flex flex-wrap gap-3 px-1 text-xs">
              <Link to={`/benchmarks/${series.benchmark.id}?case=${encodeURIComponent(series.caseKey)}`} className="text-muted-foreground hover:text-foreground underline underline-offset-4">Full history of this series</Link>
              <Link to={`/runs/${candidateDetail.run.id}`} className="text-muted-foreground hover:text-foreground underline underline-offset-4">Candidate run</Link>
              {comparison && <Link to={`/runs/${comparison.baseline.run.id}`} className="text-muted-foreground hover:text-foreground underline underline-offset-4">Baseline run</Link>}
            </div>
          </section>
        )}
      </div>
    </Panel>
  );
}

