import { useState } from "react";
import { Link, useParams } from "react-router";
import { ErrorBar } from "recharts";
import { graphql } from "@/gql";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from "@/components/ui/breadcrumb";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { EvilBarChart } from "@/components/evilcharts/charts/recharts-bar-chart";
import { ChartTooltip } from "@/components/evilcharts/ui/recharts-tooltip";
import type { ChartConfig } from "@/components/evilcharts/ui/recharts-chart";
import { SamplesChart } from "@/components/bench/series-charts";
import { Code, ErrorState, Field, LoadingState, NotFound, VerdictBadge } from "@/components/bench/states";
import { useGraphQL } from "@/lib/graphql";
import { bytes, dateTime, duration, durationScale, percentFromRatio } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { Statistic } from "@/gql/graphql";

const RunQuery = graphql(`
  query Run($id: ID!) {
    run(id: $id) {
      id
      title
      recordedAt
      conditions
      environment
      invocation
      warmup
      notes
      baselinePosition
      exportPath
      sourcePath
      checkoutPath
      checkoutHead
      checkoutBranch
      checkoutDirty
      legacyId
      repository { id slug name }
      machine { id hostname os arch cpu ram }
      measurements {
        id position label caseKey command exportedCommand commitSha dirty commitInferred revision build notes status
        n mean median stddev min max q1 q3 p95 cv userTime systemTime rssMedian rssPeak times
        benchmark { id key title }
        commit { shortSha subject url pullRequests { id title number } }
        parameters { name value }
      }
    }
  }
`);

const RunComparisonQuery = graphql(`
  query RunComparison($ids: [ID!]!, $baseline: ID!, $statistic: Statistic!) {
    measurements(ids: $ids) {
      id
      compare(baseline: $baseline, statistic: $statistic) { ratio low high verdict }
    }
  }
`);

const RunPairsQuery = graphql(`
  query RunPairs($id: ID!, $statistic: Statistic!) {
    run(id: $id) {
      id
      pairedComparisons(statistic: $statistic) { ratio low high verdict sameRun candidate { id } baseline { id position } }
    }
  }
`);

const chartConfig = {
  value: { label: "Statistic", colors: { light: ["#2563eb", "#60a5fa"], dark: ["#60a5fa", "#3b82f6"] } },
} satisfies ChartConfig;

export function RunPage() {
  const { id = "" } = useParams();
  const [statistic, setStatistic] = useState<Statistic>("MEDIAN");
  const [baselineChoice, setBaseline] = useState<string | null>(null);
  const query = useGraphQL(RunQuery, { id });
  const run = query.data?.run;
  const baseline = baselineChoice ?? (run?.baselinePosition ? run.measurements[run.baselinePosition - 1]?.id : null) ?? null;
  const comparisons = useGraphQL(RunComparisonQuery,
    { ids: run?.measurements.map((m) => m.id) ?? [], baseline: baseline ?? "", statistic },
    { enabled: Boolean(run && baseline) });
  const pairs = useGraphQL(RunPairsQuery, { id, statistic });
  if (query.isPending) return <LoadingState rows={2} />;
  if (query.error) return <ErrorState error={query.error} />;
  if (!run) return <NotFound what="run" />;

  const byId = new Map(comparisons.data?.measurements.map((m) => [m.id, m.compare]));
  const paired = new Map(pairs.data?.run?.pairedComparisons.map((c) => [c.candidate.id, c]));
  const pick = (m: { mean: number; median: number }) => statistic === "MEAN" ? m.mean : m.median;
  const { scale, unit } = durationScale(Math.max(...run.measurements.map((m) => m.q3)));
  const rows = run.measurements.map((m) => ({
    name: `${m.position}. ${m.caseKey}${m.commitSha ? ` @${m.commitSha.slice(0, 7)}` : ""}`,
    value: pick(m) * scale,
    spread: [(pick(m) - m.q1) * scale, (m.q3 - pick(m)) * scale],
    m,
  }));

  return (
    <div className="space-y-6">
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem><BreadcrumbLink asChild><Link to="/">Repositories</Link></BreadcrumbLink></BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem><BreadcrumbLink asChild><Link to={`/repositories/${run.repository.id}`}>{run.repository.slug}</Link></BreadcrumbLink></BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem><BreadcrumbPage>Run {run.id}</BreadcrumbPage></BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{run.title ?? "Untitled run"}</h1>
          <p className="text-muted-foreground text-sm">
            {dateTime(run.recordedAt)} · {run.machine.hostname} · {run.measurements.length} cases
            {run.legacyId && <> · imported from pi <Code>{run.legacyId}</Code></>}
          </p>
        </div>
        <ToggleGroup type="single" size="sm" variant="outline" value={statistic} onValueChange={(value) => value && setStatistic(value as Statistic)}>
          <ToggleGroupItem value="MEDIAN">Median</ToggleGroupItem>
          <ToggleGroupItem value="MEAN">Mean</ToggleGroupItem>
        </ToggleGroup>
      </div>

      <div className="grid gap-6 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>{statistic === "MEAN" ? "Mean" : "Median"} per case</CardTitle>
            <CardDescription>Whiskers span the interquartile range ({unit})</CardDescription>
          </CardHeader>
          <CardContent>
            <div style={{ height: Math.max(180, rows.length * 32 + 48) }}>
              <EvilBarChart className="h-full w-full" data={rows} config={chartConfig} layout="horizontal" barRadius={4} animationType="none"
                chartProps={{ margin: { left: 8, right: 24 } }}>
                <EvilBarChart.Grid horizontal={false} vertical />
                <EvilBarChart.XAxis type="number" tickFormatter={(value: number) => `${+value.toPrecision(3)} ${unit}`} />
                <EvilBarChart.YAxis type="category" dataKey="name" width={200} interval={0} tick={{ fontSize: 11 }} />
                <ChartTooltip cursor={{ fillOpacity: 0.4 }} content={({ active, payload }) => {
                  const row = payload?.[0]?.payload as (typeof rows)[number] | undefined;
                  if (!active || !row) return null;
                  return (
                    <div className="bg-background border-border/50 grid gap-1 rounded-lg border px-2.5 py-2 text-xs shadow-xl">
                      <span className="font-medium">{row.m.label}</span>
                      <span className="font-mono">{duration(pick(row.m))} · IQR {duration(row.m.q1)} – {duration(row.m.q3)} · n={row.m.n}</span>
                    </div>
                  );
                }} />
                <EvilBarChart.Bar dataKey="value"
                  barProps={{ children: <ErrorBar dataKey="spread" direction="x" width={6} strokeWidth={1.5} stroke="var(--foreground)" opacity={0.5} /> }} />
              </EvilBarChart>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Samples</CardTitle>
            <CardDescription>Every timed iteration per case, in seconds scaled to {unit}</CardDescription>
          </CardHeader>
          <CardContent>
            <SamplesChart
              commits={run.measurements.map((m) => ({ position: m.position, label: String(m.position) }))}
              sets={run.measurements.map((m) => ({ position: m.position, label: String(m.position), times: m.times, dirty: m.dirty ?? false }))}
            />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Cases</CardTitle>
          <CardDescription>
            Repeated cases are compared with their first occurrence in this run; click a cell to compare every case against one baseline instead.
            Changes are {statistic.toLowerCase()} ratios with bootstrap 95% intervals.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Case</TableHead>
                <TableHead>Commit</TableHead>
                <TableHead className="text-right">{statistic === "MEAN" ? "Mean" : "Median"}</TableHead>
                <TableHead className="text-right">± SD</TableHead>
                <TableHead className="text-right">Min … Max</TableHead>
                <TableHead className="text-right">n</TableHead>
                <TableHead className="text-right">RSS</TableHead>
                <TableHead className="text-right">Change</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {run.measurements.map((m) => {
                const pair = baselineChoice ? undefined : paired.get(m.id);
                const comparison = pair ?? byId.get(m.id);
                const isBaseline = m.id === baseline;
                return (
                  <TableRow key={m.id}>
                    <TableCell className="max-w-80">
                      <div className="flex items-center gap-2">
                        <span className="truncate font-medium">{m.label}</span>
                        {m.status !== "PASSED" && <Badge variant={m.status === "FAILED" ? "destructive" : "outline"} className="text-[10px]">{m.status.toLowerCase()}</Badge>}
                      </div>
                      <div className="text-muted-foreground font-mono text-xs">{m.benchmark.key} · {m.caseKey}</div>
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {m.commit ? (m.commit.url ? <a href={m.commit.url} target="_blank" rel="noreferrer" className="hover:underline">{m.commit.shortSha.slice(0, 7)}</a> : m.commit.shortSha.slice(0, 7)) : "—"}
                      {m.dirty && <span className="text-amber-600 dark:text-amber-400"> +dirty</span>}
                      {m.commitInferred && <span className="text-muted-foreground"> (inferred)</span>}
                      {m.commit?.pullRequests.map((pr) => <Link key={pr.id} to={`/pr/${pr.id}`} className="ml-1 hover:underline">{pr.number ? `#${pr.number}` : "PR"}</Link>)}
                    </TableCell>
                    <TableCell className="text-right font-mono tabular-nums">{duration(pick(m))}</TableCell>
                    <TableCell className="text-muted-foreground text-right font-mono tabular-nums">{duration(m.stddev)}</TableCell>
                    <TableCell className="text-muted-foreground text-right font-mono text-xs tabular-nums">{duration(m.min)} … {duration(m.max)}</TableCell>
                    <TableCell className="text-right tabular-nums">{m.n}</TableCell>
                    <TableCell className="text-muted-foreground text-right text-xs">{bytes(m.rssPeak)}</TableCell>
                    <TableCell className="text-right">
                      <button type="button" onClick={() => setBaseline(m.id)} className={cn("rounded px-1.5 py-0.5 text-xs hover:bg-muted", isBaseline && "bg-muted font-medium")}>
                        {isBaseline && !pair ? "baseline" : comparison ? (
                          <span className="inline-flex items-center gap-2" title={`95% CI ${percentFromRatio(comparison.low, 2)} … ${percentFromRatio(comparison.high, 2)}`}>
                            {pair && <span className="text-muted-foreground">vs {pair.baseline.position}.</span>}
                            <span className="font-mono tabular-nums">{percentFromRatio(comparison.ratio, 2)}</span>
                            <VerdictBadge verdict={comparison.verdict} className="text-[10px]" />
                          </span>
                        ) : baseline ? "…" : "set baseline"}
                      </button>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Provenance</CardTitle></CardHeader>
        <CardContent>
          <dl className="grid gap-5 md:grid-cols-2">
            <Field label="Conditions">{run.conditions}</Field>
            <Field label="Environment">{run.environment}</Field>
            <Field label="Invocation">{run.invocation && <Code>{run.invocation}</Code>}</Field>
            <Field label="Warmup">{run.warmup}</Field>
            <Field label="Machine">{run.machine.hostname} · {run.machine.cpu} · {run.machine.os} {run.machine.arch} · {bytes(run.machine.ram)}</Field>
            <Field label="Checkout">{run.checkoutPath && <>{run.checkoutPath} {run.checkoutBranch && <>({run.checkoutBranch})</>} @ <span className="font-mono text-xs">{run.checkoutHead?.slice(0, 10)}</span>{run.checkoutDirty ? " · dirty" : ""}</>}</Field>
            <Field label="Raw export"><Code>{run.exportPath}</Code></Field>
            <Field label="Notes">{run.notes}</Field>
          </dl>
          <Table className="mt-6">
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">#</TableHead>
                <TableHead>Command</TableHead>
                <TableHead>Build and notes</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {run.measurements.map((m) => (
                <TableRow key={m.id}>
                  <TableCell className="text-muted-foreground align-top">{m.position}</TableCell>
                  <TableCell className="max-w-xl align-top whitespace-normal"><Code className="break-all">{m.command ?? m.exportedCommand}</Code></TableCell>
                  <TableCell className="text-muted-foreground max-w-md align-top text-xs whitespace-normal">
                    {[m.build, m.revision, m.notes, m.parameters?.map((p) => `${p.name}=${p.value}`).join(", "),
                      m.userTime !== null ? `CPU user ${duration(m.userTime)}, system ${duration(m.systemTime)}` : null].filter(Boolean).join(" · ")}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
