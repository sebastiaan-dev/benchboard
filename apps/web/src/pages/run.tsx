import { useState } from "react";
import { Link, useParams } from "react-router";
import { ErrorBar } from "recharts";
import { BarChart3, Flame, ListChecks, ScatterChart, Terminal } from "lucide-react";
import { graphql } from "@/gql";
import { EvilBarChart } from "@/components/evilcharts/charts/recharts-bar-chart";
import { ChartTooltip } from "@/components/evilcharts/ui/recharts-tooltip";
import type { ChartConfig } from "@/components/evilcharts/ui/recharts-chart";
import { SamplesChart } from "@/components/bench/series-charts";
import { ErrorState, LoadingState, NotFound, VerdictBadge } from "@/components/bench/states";
import { Crumbs, useRepositoryScope } from "@/components/shell";
import { KeyValues, Panel, PanelHeader, Stat, StatStrip, Well } from "@/components/kit/panel";
import { Pill, Segmented, verdictVar } from "@/components/kit/encodings";
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
        profiles { id label cpuMs symbolicatedShare }
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
      pairedComparisons(statistic: $statistic) { ratio low high verdict sameRun candidate { id } baseline { id position commitSha } }
    }
  }
`);

const chartConfig = {
  before: { label: "First commit", colors: { light: ["#a3a3a3"], dark: ["#6b6b73"] } },
  after: { label: "Later commits", colors: { light: ["#2563eb"], dark: ["#7ea6f6"] } },
} satisfies ChartConfig;

export function RunPage() {
  const { id = "" } = useParams();
  const [statistic, setStatistic] = useState<Statistic>("MEDIAN");
  const [baselineChoice, setBaseline] = useState<string | null>(null);
  const query = useGraphQL(RunQuery, { id });
  const run = query.data?.run;
  useRepositoryScope(run?.repository.id);
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
  // The first commit in the run is the "before" side: its bars are grey, later commits are colored.
  const firstCommit = run.measurements[0]?.commitSha;
  const rows = run.measurements.map((m) => {
    const before = m.commitSha === firstCommit;
    return {
      name: `${m.caseKey}${m.commitSha ? ` @${m.commitSha.slice(0, 7)}` : ""}`,
      [before ? "before" : "after"]: pick(m) * scale,
      [before ? "beforeSpread" : "afterSpread"]: [(pick(m) - m.q1) * scale, (m.q3 - pick(m)) * scale],
      m,
    };
  });
  const pairList = pairs.data?.run?.pairedComparisons ?? [];
  const pairVerdicts = { faster: pairList.filter((c) => c.verdict === "IMPROVEMENT").length, slower: pairList.filter((c) => c.verdict === "REGRESSION").length };
  const failed = run.measurements.filter((m) => m.status === "FAILED").length;
  const samples = run.measurements.reduce((sum, m) => sum + m.n, 0);
  const profiles = run.measurements.reduce((sum, m) => sum + m.profiles.length, 0);
  const GRID = "grid-cols-[minmax(0,1fr)_6.5rem_5.5rem_5rem_3rem_14rem]";

  return (
    <div className="space-y-5">
      <Crumbs items={[
        { label: run.repository.name, to: `/repositories/${run.repository.id}` },
        { label: "Runs", to: `/repositories/${run.repository.id}/runs` },
        { label: run.title ?? run.id },
      ]} />
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <span className="bg-card text-muted-foreground mt-0.5 flex size-10 shrink-0 items-center justify-center rounded-xl border"><ListChecks className="size-5" /></span>
          <div className="min-w-0 space-y-1">
            <div className="flex items-center gap-2">
              <h1 className="truncate text-xl font-semibold tracking-tight">{run.title ?? "Untitled run"}</h1>
              {failed > 0 && <Pill color={verdictVar.FAILED}>{failed} failed</Pill>}
              {run.legacyId && <Pill>imported from pi</Pill>}
            </div>
            <p className="text-muted-foreground truncate font-mono text-xs">{run.id} · {dateTime(run.recordedAt)} · {run.machine.hostname}</p>
          </div>
        </div>
        <Segmented value={statistic} onChange={setStatistic} options={[{ value: "MEDIAN", label: "Median" }, { value: "MEAN", label: "Mean" }]} />
      </div>

      <Panel>
        <StatStrip className={cn("sm:grid-cols-2", profiles > 0 ? "xl:grid-cols-5" : "xl:grid-cols-4")}>
          <Stat label="Cases" value={run.measurements.length} detail={`${new Set(run.measurements.map((m) => m.commitSha)).size} commits`} />
          <Stat label="Samples" value={samples.toLocaleString()} detail={`warmup ${run.warmup ?? "—"}`} />
          <Stat label="Paired comparisons" value={pairList.length}
            detail={pairList.length ? `${pairVerdicts.faster} faster · ${pairVerdicts.slower} slower · ${pairList.length - pairVerdicts.faster - pairVerdicts.slower} other` : "no repeated cases"} />
          <Stat label="Machine" value={<span className="truncate text-base">{run.machine.hostname}</span>} detail={run.machine.cpu} />
          {profiles > 0 && <Stat label="Profiles" value={profiles} detail="attached to cases" />}
        </StatStrip>
      </Panel>

      <div className="grid gap-5 xl:grid-cols-2">
        <Panel>
          <PanelHeader icon={BarChart3} title={`${statistic === "MEAN" ? "Mean" : "Median"} per case`} subtitle={`Whiskers span the interquartile range · ${unit}`} />
          <div className="px-4 pb-4">
            <Well className="p-2" >
              <div style={{ height: Math.max(180, rows.length * 30 + 48) }}>
                <EvilBarChart className="h-full w-full" data={rows} config={chartConfig} layout="horizontal" stackType="stacked" barRadius={4} animationType="none"
                  chartProps={{ margin: { left: 8, right: 24 } }}>
                  <EvilBarChart.Grid horizontal={false} vertical />
                  <EvilBarChart.XAxis type="number" tickFormatter={(value: number) => `${+value.toPrecision(3)} ${unit}`} />
                  <EvilBarChart.YAxis type="category" dataKey="name" width={190} interval={0} tick={{ fontSize: 11, fontFamily: "var(--font-mono)" }} />
                  <ChartTooltip cursor={{ fillOpacity: 0.3 }} content={({ active, payload }) => {
                    const row = payload?.[0]?.payload as (typeof rows)[number] | undefined;
                    if (!active || !row) return null;
                    return (
                      <div className="bg-popover grid gap-1 rounded-lg border px-2.5 py-2 text-xs shadow-xl">
                        <span className="font-medium">{row.m.label}</span>
                        <span className="font-mono">{duration(pick(row.m))} · IQR {duration(row.m.q1)} – {duration(row.m.q3)} · n={row.m.n}</span>
                      </div>
                    );
                  }} />
                  <EvilBarChart.Bar dataKey="before"
                    barProps={{ children: <ErrorBar dataKey="beforeSpread" direction="x" width={6} strokeWidth={1.5} stroke="var(--foreground)" opacity={0.5} /> }} />
                  <EvilBarChart.Bar dataKey="after"
                    barProps={{ children: <ErrorBar dataKey="afterSpread" direction="x" width={6} strokeWidth={1.5} stroke="var(--foreground)" opacity={0.5} /> }} />
                </EvilBarChart>
              </div>
            </Well>
          </div>
        </Panel>
        <Panel>
          <PanelHeader icon={ScatterChart} title="Samples" subtitle="Every timed iteration per case" />
          <div className="px-4 pb-4">
            <Well className="p-2">
              <SamplesChart
                commits={run.measurements.map((m) => ({ position: m.position, label: String(m.position) }))}
                sets={run.measurements.map((m) => ({ position: m.position, label: String(m.position), times: m.times, dirty: m.dirty ?? false }))}
              />
            </Well>
          </div>
        </Panel>
      </div>

      <Panel>
        <PanelHeader icon={ListChecks} title="Cases"
          subtitle={`Repeated cases compare with their first occurrence · click a change to use one baseline · ${statistic.toLowerCase()} ratio, bootstrap 95% CI`}
          actions={baselineChoice && <button type="button" className="text-muted-foreground text-xs underline" onClick={() => setBaseline(null)}>reset baseline</button>} />
        <div className="px-2 pb-2">
          <div className={cn("text-muted-foreground grid gap-4 px-3 pb-1.5 text-xs", GRID)}>
            <span>Case</span><span>Commit</span><span className="text-right">{statistic === "MEAN" ? "Mean" : "Median"}</span><span className="text-right">± SD</span><span className="text-right">n</span><span className="text-right">Change</span>
          </div>
          {run.measurements.map((m) => {
            const pair = baselineChoice ? undefined : paired.get(m.id);
            const comparison = pair ?? byId.get(m.id);
            const isBaseline = m.id === baseline;
            return (
              <div key={m.id} className={cn("hover:bg-accent/40 grid items-center gap-4 rounded-lg px-3 py-2", GRID)}>
                <span className="min-w-0">
                  <span className="flex items-center gap-2">
                    <span className="truncate text-sm">{m.label}</span>
                    {m.status !== "PASSED" && <Pill color={m.status === "FAILED" ? verdictVar.FAILED : "var(--warn)"} className="h-5 text-[10.5px]">{m.status.toLowerCase()}</Pill>}
                    {m.profiles.map((profile) => (
                      <Link key={profile.id} to={`/profiles/${profile.id}`} className="inline-flex items-center gap-1 text-xs text-orange-500 hover:underline">
                        <Flame className="size-3.5" />{profile.label ?? "profile"}
                      </Link>
                    ))}
                  </span>
                  <span className="text-muted-foreground block truncate font-mono text-[11px]">{m.benchmark.key} · {m.caseKey}</span>
                </span>
                <span className="truncate font-mono text-xs">
                  {m.commit ? (m.commit.url ? <a href={m.commit.url} target="_blank" rel="noreferrer" className="hover:underline">{m.commit.shortSha.slice(0, 7)}</a> : m.commit.shortSha.slice(0, 7)) : "—"}
                  {m.dirty && <span className="text-warn">*</span>}
                  {m.commit?.pullRequests.map((pr) => <Link key={pr.id} to={`/pr/${pr.id}`} className="text-muted-foreground ml-1 hover:underline">{pr.number ? `#${pr.number}` : "PR"}</Link>)}
                </span>
                <span className="text-right font-mono text-sm tabular-nums">{duration(pick(m))}</span>
                <span className="text-muted-foreground text-right font-mono text-xs tabular-nums">{duration(m.stddev)}</span>
                <span className="text-muted-foreground text-right font-mono text-xs">{m.n}</span>
                <span className="text-right">
                  <button type="button" onClick={() => setBaseline(m.id)} className={cn("hover:bg-accent inline-flex items-center gap-2 rounded px-1.5 py-0.5 text-xs whitespace-nowrap", isBaseline && !pair && "bg-accent")}>
                    {isBaseline && !pair ? "baseline" : comparison ? <>
                      {pair && <span className="text-muted-foreground font-mono">vs {pair.baseline.commitSha?.slice(0, 7) ?? `case ${pair.baseline.position}`}</span>}
                      <span className="font-mono tabular-nums" title={`95% CI ${percentFromRatio(comparison.low, 2)} … ${percentFromRatio(comparison.high, 2)}`}>{percentFromRatio(comparison.ratio, 2)}</span>
                      <VerdictBadge verdict={comparison.verdict} />
                    </> : <span className="text-muted-foreground">set baseline</span>}
                  </button>
                </span>
              </div>
            );
          })}
        </div>
      </Panel>

      <div className="grid items-start gap-5 xl:grid-cols-2">
        <Panel>
          <PanelHeader icon={ListChecks} title="Provenance" subtitle="Recorded with the run" />
          <div className="px-4 pb-4">
            <KeyValues rows={[
              ["conditions", run.conditions], ["environment", run.environment], ["invocation", run.invocation], ["warmup", run.warmup],
              ["machine", `${run.machine.hostname} · ${run.machine.cpu} · ${run.machine.os} ${run.machine.arch} · ${bytes(run.machine.ram)}`],
              ["checkout", run.checkoutPath && <>{run.checkoutPath}{run.checkoutBranch ? ` (${run.checkoutBranch})` : ""} @ {run.checkoutHead?.slice(0, 10)}{run.checkoutDirty ? " // dirty" : ""}</>],
              ["raw export", run.exportPath], ["notes", run.notes],
            ]} />
          </div>
        </Panel>
        <Panel>
          <PanelHeader icon={Terminal} title="Commands" subtitle="Exact measured commands and builds" />
          <div className="px-4 pb-4">
            <Well className="divide-y overflow-hidden">
              {run.measurements.map((m) => (
                <div key={m.id} className="grid grid-cols-[1.5rem_1fr] gap-2 px-3 py-2 font-mono text-xs">
                  <span className="text-muted-foreground">{m.position}</span>
                  <span className="min-w-0 space-y-0.5">
                    <span className="block break-all">{m.command ?? m.exportedCommand}</span>
                    <span className="text-muted-foreground block break-words">
                      {[m.build, m.revision, m.notes, m.parameters?.map((p) => `${p.name}=${p.value}`).join(", "),
                        m.userTime !== null ? `cpu user ${duration(m.userTime)} · system ${duration(m.systemTime)}` : null,
                        m.rssPeak !== null ? `rss peak ${bytes(m.rssPeak)}` : null].filter(Boolean).join(" · ")}
                    </span>
                  </span>
                </div>
              ))}
            </Well>
          </div>
        </Panel>
      </div>
    </div>
  );
}
