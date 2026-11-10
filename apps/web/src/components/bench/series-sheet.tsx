import { Link } from "react-router";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { SamplesChart, TrendChart, type TrendPoint } from "@/components/bench/series-charts";
import { Code, Field, VerdictBadge } from "@/components/bench/states";
import { useGraphQL } from "@/lib/graphql";
import { duration, percentFromRatio, seriesName } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { Statistic } from "@/gql/graphql";
import type { Report, Series } from "@/pages/pull-request";
import { SeriesSamplesQuery } from "@/pages/pull-request.queries";

type Comparison = Series["points"][number]["vsReference"];

function Change({ comparison }: { comparison: Comparison }) {
  if (!comparison) return <span className="text-muted-foreground">—</span>;
  const tone = comparison.verdict === "REGRESSION" ? "text-red-600 dark:text-red-400"
    : comparison.verdict === "IMPROVEMENT" ? "text-emerald-600 dark:text-emerald-400" : "";
  return (
    <span className={cn("font-mono tabular-nums", tone)} title={`95% CI ${percentFromRatio(comparison.low, 2)} … ${percentFromRatio(comparison.high, 2)}${comparison.sameRun ? "" : " (cross-run)"}`}>
      {percentFromRatio(comparison.ratio, 1)}
    </span>
  );
}

export function SeriesSheet({ series, report, statistic, onClose }: {
  series: Series | null; report: Report; statistic: Statistic; onClose: () => void;
}) {
  const ids = series ? series.points.flatMap((point) => point.measurement ? [point.measurement.id] : []) : [];
  const samples = useGraphQL(SeriesSamplesQuery, { ids }, { enabled: ids.length > 0 });
  const byId = new Map(samples.data?.measurements.map((measurement) => [measurement.id, measurement]));
  const columns = report.commits.map((entry) => ({ position: entry.position, label: entry.isBase ? "base" : entry.commit.shortSha.slice(0, 7) }));
  const pick = (m: { mean: number; median: number }) => statistic === "MEAN" ? m.mean : m.median;

  const trend: TrendPoint[] = series ? series.points.map((point, index) => {
    const m = point.measurement;
    return {
      position: point.position, label: columns[index].label, subject: report.commits[index].commit.subject ?? "",
      value: m ? pick(m) : null, q1: m?.q1 ?? null, q3: m?.q3 ?? null, min: m?.min ?? null, max: m?.max ?? null,
      n: m?.n ?? null, dirty: m?.dirty ?? false,
    };
  }) : [];
  const reference = series?.points.find((point) => point.position === series.reference?.position)?.measurement;
  const latest = series?.points.find((point) => point.position === series.latest?.position)?.measurement;
  const latestDetail = latest ? byId.get(latest.id) : undefined;

  return (
    <Sheet open={series !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full overflow-y-auto data-[side=right]:w-full data-[side=right]:sm:max-w-3xl">
        {series && <>
          <SheetHeader>
            <div className="flex items-center gap-2">
              <SheetTitle className="text-lg">{seriesName(series.benchmark.key, series.caseKey)}</SheetTitle>
              <VerdictBadge verdict={series.verdict} />
            </div>
            <SheetDescription>
              {series.benchmark.title}{series.benchmark.title ? " · " : ""}
              {series.latestComparison
                ? <>head {percentFromRatio(series.latestComparison.ratio, 2)} vs {series.referenceIsBase ? "base" : "first measured commit"} (95% CI {percentFromRatio(series.latestComparison.low, 2)} … {percentFromRatio(series.latestComparison.high, 2)}, {series.latestComparison.sameRun ? "same run" : "different runs"})</>
                : "Only one commit measured"}
            </SheetDescription>
          </SheetHeader>
          <div className="space-y-6 px-4 pb-8">
            <section className="space-y-2">
              <h3 className="text-sm font-medium">{statistic === "MEAN" ? "Mean" : "Median"} per commit</h3>
              <p className="text-muted-foreground text-xs">Shaded: interquartile range and min–max of each commit's samples. Dashed: reference.</p>
              <TrendChart points={trend} reference={reference ? pick(reference) : null} statistic={statistic === "MEAN" ? "Mean" : "Median"} />
            </section>
            <section className="space-y-2">
              <h3 className="text-sm font-medium">All samples</h3>
              <p className="text-muted-foreground text-xs">One dot per timed run of the representative measurement; diamonds are dirty builds.</p>
              {samples.isPending ? <Skeleton className="h-64" /> : (
                <SamplesChart
                  commits={columns}
                  sets={series.points.flatMap((point) => {
                    const m = point.measurement && byId.get(point.measurement.id);
                    return m ? [{ position: point.position, label: point.position === 0 ? "base" : String(point.position), times: m.times, dirty: m.dirty ?? false }] : [];
                  })}
                />
              )}
            </section>
            <section className="space-y-2">
              <h3 className="text-sm font-medium">Measurements</h3>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Commit</TableHead>
                    <TableHead className="text-right">{statistic === "MEAN" ? "Mean" : "Median"}</TableHead>
                    <TableHead className="text-right">n</TableHead>
                    <TableHead className="text-right">CV</TableHead>
                    <TableHead className="text-right">vs ref</TableHead>
                    <TableHead className="text-right">vs prev</TableHead>
                    <TableHead>Run</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {series.points.map((point, index) => {
                    const m = point.measurement;
                    return (
                      <TableRow key={point.position} className={cn(!m && "text-muted-foreground")}>
                        <TableCell>
                          <div className="font-mono text-xs">{columns[index].label}{m?.dirty ? " +dirty" : ""}</div>
                          <div className="text-muted-foreground max-w-56 truncate text-xs">{report.commits[index].commit.subject}</div>
                        </TableCell>
                        <TableCell className="text-right font-mono tabular-nums">{m ? duration(pick(m)) : "—"}</TableCell>
                        <TableCell className="text-right tabular-nums">{m?.n ?? ""}</TableCell>
                        <TableCell className="text-right tabular-nums">{m?.cv !== null && m?.cv !== undefined ? `${(m.cv * 100).toFixed(1)}%` : ""}</TableCell>
                        <TableCell className="text-right">{point.position === series.reference?.position ? <span className="text-muted-foreground text-xs">reference</span> : <Change comparison={point.vsReference} />}</TableCell>
                        <TableCell className="text-right"><Change comparison={point.vsPrevious} /></TableCell>
                        <TableCell>
                          {m && <Link className="text-xs underline-offset-4 hover:underline" to={`/runs/${m.run.id}`}>{m.run.title ?? m.run.id}</Link>}
                          {point.candidates.length > 1 && <div className="text-muted-foreground text-xs">+{point.candidates.length - 1} other</div>}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </section>
            {latestDetail && <>
              <Separator />
              <section className="space-y-3">
                <h3 className="text-sm font-medium">Provenance of the latest measurement</h3>
                <dl className="grid gap-4 sm:grid-cols-2">
                  <Field label="Command"><Code>{latestDetail.command ?? latestDetail.exportedCommand}</Code></Field>
                  <Field label="Build">{latestDetail.build}</Field>
                  <Field label="Conditions">{latestDetail.run.conditions}</Field>
                  <Field label="Environment">{latestDetail.run.environment}</Field>
                  <Field label="Machine">{latestDetail.run.machine.hostname} · {latestDetail.run.machine.cpu}</Field>
                  <Field label="Commit">
                    <span className="font-mono text-xs">{latestDetail.commitSha}</span>
                    {latestDetail.commitInferred && <span className="text-muted-foreground"> (inferred, not recorded)</span>}
                  </Field>
                </dl>
              </section>
            </>}
          </div>
        </>}
      </SheetContent>
    </Sheet>
  );
}
