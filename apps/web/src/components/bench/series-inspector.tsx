import { Link } from "react-router";
import { ChevronLeft, ChevronRight, Flame, GitCompare, LineChart } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { DistributionChart, TrendChart, type TrendPoint } from "@/components/bench/series-charts";
import { VerdictBadge } from "@/components/bench/states";
import { KeyValues, MicroLabel, Panel, PanelHeader, SectionLabel, Stat, StatStrip, Well } from "@/components/kit/panel";
import { WideInterval, verdictVar } from "@/components/kit/encodings";
import { useGraphQL } from "@/lib/graphql";
import { duration, percentFromRatio } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { Statistic } from "@/gql/graphql";
import type { Report, Series } from "@/pages/pull-request";
import { SeriesSamplesQuery } from "@/pages/pull-request.queries";

type Comparison = Series["points"][number]["vsReference"];

function Change({ comparison }: { comparison: Comparison }) {
  if (!comparison) return <span className="text-muted-foreground/60">—</span>;
  return (
    <span className="font-mono tabular-nums" style={{ color: comparison.verdict === "UNCHANGED" ? undefined : verdictVar[comparison.verdict] }}
      title={`95% CI ${percentFromRatio(comparison.low, 2)} … ${percentFromRatio(comparison.high, 2)}${comparison.sameRun ? "" : " (cross-run)"}`}>
      {percentFromRatio(comparison.ratio, 1)}
    </span>
  );
}

/** Persistent detail panel for one series: interval, trend, distributions, measurements, provenance. */
export function SeriesInspector({ series, report, statistic, threshold, position, onPrevious, onNext, profilesAnchor }: {
  series: Series; report: Report; statistic: Statistic; threshold: number;
  position: { index: number; total: number } | null; onPrevious?: () => void; onNext?: () => void; profilesAnchor?: string;
}) {
  const reference = series.points.find((point) => point.position === series.reference?.position);
  const latest = series.points.find((point) => point.position === series.latest?.position);
  const ids = [reference?.measurement?.id, latest?.measurement?.id].filter((id): id is string => Boolean(id));
  const samples = useGraphQL(SeriesSamplesQuery, { ids: [...new Set(ids)] }, { enabled: ids.length > 0 });
  const byId = new Map(samples.data?.measurements.map((measurement) => [measurement.id, measurement]));
  const pick = (m: { mean: number; median: number }) => statistic === "MEAN" ? m.mean : m.median;
  const columns = report.commits.map((entry) => entry.isBase ? "base" : entry.commit.shortSha.slice(0, 7));
  const comparison = series.latestComparison;
  const trend: TrendPoint[] = series.points.map((point, index) => {
    const m = point.measurement;
    return {
      position: point.position, label: columns[index], subject: report.commits[index].commit.subject ?? "",
      value: m ? pick(m) : null, q1: m?.q1 ?? null, q3: m?.q3 ?? null, min: m?.min ?? null, max: m?.max ?? null, n: m?.n ?? null, dirty: m?.dirty ?? false,
    };
  });
  const extent = Math.max(0.05, comparison ? Math.max(Math.abs(comparison.low - 1), Math.abs(comparison.high - 1)) * 1.3 : 0.05);
  const latestDetail = latest?.measurement ? byId.get(latest.measurement.id) : undefined;
  const latestProfile = [...series.points].reverse().find((point) => point.measurement?.profiles.length)?.measurement?.profiles[0];
  const name = series.caseKey === "default" ? series.benchmark.key : `${series.benchmark.key} · ${series.caseKey}`;
  const label = (point: Series["points"][number] | undefined) => point ? (point.isBase ? "base" : `#${point.position}`) : "—";

  return (
    <Panel>
      <PanelHeader
        icon={LineChart}
        title={name}
        subtitle={series.benchmark.title ?? series.label}
        actions={<>
          <VerdictBadge verdict={series.verdict} />
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
        <Well className="p-4">
          <div className="flex items-end justify-between gap-4">
            <div>
              <MicroLabel>{statistic === "MEAN" ? "Mean" : "Median"} · head vs {series.referenceIsBase ? "base" : label(reference)}</MicroLabel>
              <div className="mt-1 text-3xl font-semibold tracking-tight tabular-nums"
                style={{ color: comparison && comparison.verdict !== "UNCHANGED" ? verdictVar[comparison.verdict] : undefined }}>
                {comparison ? percentFromRatio(comparison.ratio, 2) : "—"}
              </div>
              <div className="text-muted-foreground mt-1 font-mono text-[11px]">
                {comparison ? <>95% CI {percentFromRatio(comparison.low, 2)} … {percentFromRatio(comparison.high, 2)} · {comparison.resamples} resamples · {comparison.sameRun ? "same run" : "cross-run"}</> : "only one commit measured"}
              </div>
            </div>
          </div>
          {comparison && (
            <div className="mt-4">
              <WideInterval ratio={comparison.ratio} low={comparison.low} high={comparison.high} verdict={comparison.verdict} threshold={threshold} extent={extent} height={22} />
              <div className="text-muted-foreground mt-1 flex justify-between font-mono text-[10px]">
                <span>{percentFromRatio(1 - extent, 0)}</span><span>±{(threshold * 100).toFixed(1)}% threshold</span><span>{percentFromRatio(1 + extent, 0)}</span>
              </div>
            </div>
          )}
        </Well>

        <StatStrip className="bg-well grid-cols-2 rounded-xl border sm:grid-cols-4 [&>*]:px-3 [&>*]:py-3">
          <Stat label={`Ref ${label(reference)}`} value={reference?.measurement ? duration(pick(reference.measurement)) : "—"} detail={reference?.measurement ? `n=${reference.measurement.n}` : undefined} className="[&_div:nth-child(2)]:text-lg" />
          <Stat label={`Head ${label(latest)}`} value={latest?.measurement ? duration(pick(latest.measurement)) : "—"} detail={latest?.measurement ? `n=${latest.measurement.n}` : undefined} className="[&_div:nth-child(2)]:text-lg" />
          <Stat label="CV head" value={latest?.measurement?.cv !== null && latest?.measurement?.cv !== undefined ? `${(latest.measurement.cv * 100).toFixed(1)}%` : "—"} className="[&_div:nth-child(2)]:text-lg" />
          <Stat label="Measured" value={series.points.filter((point) => point.measurement).length} unit={`/ ${series.points.length}`} className="[&_div:nth-child(2)]:text-lg" />
        </StatStrip>

        {(latestProfile || profilesAnchor) && (
          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-orange-500/25 bg-orange-500/[0.06] px-3 py-2">
            <Flame className="size-4 text-orange-500" />
            <span className="text-sm">CPU profiles recorded</span>
            <div className="ml-auto flex gap-2">
              {profilesAnchor && <Button size="sm" variant="secondary" asChild><a href={profilesAnchor}><GitCompare /> Differential flame graph</a></Button>}
              {latestProfile && <Button size="sm" variant="ghost" asChild><Link to={`/profiles/${latestProfile.id}`}><Flame /> Latest</Link></Button>}
            </div>
          </div>
        )}

        <section className="space-y-2">
          <SectionLabel>Per commit</SectionLabel>
          <Well className="px-1 pt-3 pb-1">
            <TrendChart points={trend} reference={reference?.measurement ? pick(reference.measurement) : null} statistic={statistic === "MEAN" ? "Mean" : "Median"} />
          </Well>
        </section>

        {reference?.measurement && latest?.measurement && reference !== latest && (
          <section className="space-y-2">
            <SectionLabel>Sample distribution · {label(reference)} vs {label(latest)}</SectionLabel>
            <Well className="px-1 pt-3 pb-1">
              {samples.isPending ? <Skeleton className="h-48" /> : (
                <DistributionChart base={byId.get(reference.measurement.id)?.times ?? []} head={byId.get(latest.measurement.id)?.times ?? []} />
              )}
            </Well>
          </section>
        )}

        <section className="space-y-2">
          <SectionLabel count={series.points.filter((point) => point.measurement).length}>Measurements</SectionLabel>
          <Well className="divide-y overflow-hidden">
            {series.points.map((point, index) => {
              const m = point.measurement;
              return (
                <div key={point.position} className={cn("grid grid-cols-[4.5rem_1fr_5rem_3.5rem_3.5rem_1rem] items-center gap-2 px-3 py-1.5 text-xs", !m && "opacity-45")}>
                  <span className="font-mono">{columns[index]}{m?.dirty ? "*" : ""}</span>
                  <span className="text-muted-foreground truncate">
                    {m ? <Link to={`/runs/${m.run.id}`} className="hover:text-foreground">{m.run.title ?? m.run.id}</Link> : report.commits[index].commit.subject}
                  </span>
                  <span className="text-right font-mono tabular-nums">{m ? duration(pick(m)) : "—"}</span>
                  <span className="text-right">{point.position === series.reference?.position ? <span className="text-muted-foreground font-mono">ref</span> : <Change comparison={point.vsReference} />}</span>
                  <span className="text-right"><Change comparison={point.vsPrevious} /></span>
                  {m?.profiles.length ? <Link to={`/profiles/${m.profiles[0].id}`} aria-label="Profile"><Flame className="size-3.5 text-orange-500" /></Link> : <span />}
                </div>
              );
            })}
          </Well>
          <p className="text-muted-foreground font-mono text-[10.5px]">columns: value · vs reference · vs previous · * dirty build</p>
        </section>

        {latestDetail && (
          <section className="space-y-2">
            <SectionLabel>Provenance · head</SectionLabel>
            <KeyValues rows={[
              ["command", latestDetail.command ?? latestDetail.exportedCommand],
              ["build", latestDetail.build],
              ["commit", <>{latestDetail.commitSha?.slice(0, 12)}{latestDetail.commitInferred ? <span className="text-muted-foreground"> // inferred</span> : null}</>],
              ["machine", `${latestDetail.run.machine.hostname} · ${latestDetail.run.machine.cpu}`],
              ["conditions", latestDetail.run.conditions],
              ["environment", latestDetail.run.environment],
            ]} />
          </section>
        )}
      </div>
    </Panel>
  );
}
