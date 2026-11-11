import { useParams, useSearchParams, Link } from "react-router";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { History, Layers, ListChecks } from "lucide-react";
import { graphql } from "@/gql";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { TrendChart } from "@/components/bench/series-charts";
import { RunsTable } from "@/components/bench/runs-table";
import { ErrorState, LoadingState, NotFound } from "@/components/bench/states";
import { Crumbs, useRepositoryScope } from "@/components/shell";
import { Panel, PanelHeader, Stat, StatStrip, Well } from "@/components/kit/panel";
import { Sparkline } from "@/components/kit/encodings";
import { useGraphQL } from "@/lib/graphql";
import { dateTime, duration, primaryMachine, relativeTime, shortDate } from "@/lib/format";
import { cn } from "@/lib/utils";

const BenchmarkQuery = graphql(`
  query Benchmark($id: ID!) {
    benchmark(id: $id) {
      id
      key
      title
      description
      repository { id slug name }
      cases {
        caseKey
        count
        lastRecordedAt
        measurements(limit: 300) {
          id label median mean q1 q3 min max n dirty status commitSha recordedAt build
          commit { subject committedAt authoredAt }
          run { id title machine { id hostname cpu } }
          profiles { id }
        }
      }
      runs(limit: 20) { ...RunRow }
    }
  }
`);

export function BenchmarkPage() {
  const { id = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const query = useGraphQL(BenchmarkQuery, { id });
  const benchmark = query.data?.benchmark;
  useRepositoryScope(benchmark?.repository.id);
  if (query.isPending) return <LoadingState rows={2} />;
  if (query.error) return <ErrorState error={query.error} />;
  if (!benchmark) return <NotFound what="benchmark" />;
  const current = benchmark.cases.find((entry) => entry.caseKey === params.get("case")) ?? benchmark.cases[0];
  const select = (caseKey: string) => setParams({ case: caseKey }, { replace: true });
  const set = (key: string, value: string | null) => setParams((previous) => {
    const next = new URLSearchParams(previous);
    value === null ? next.delete(key) : next.set(key, value);
    return next;
  }, { replace: true });
  // History is shown per machine cohort: measurements from different machines are never joined into one line.
  const all = current?.measurements ?? [];
  const machineList = [...new Map(all.map((m) => [m.run.machine.id, m.run.machine])).values()];
  const machineId = params.get("machine") ?? primaryMachine(all);
  const includeDirty = params.get("dirty") === "1";
  const cohort = all.filter((m) => m.run.machine.id === machineId && m.status !== "FAILED" && (includeDirty || !m.dirty));
  const builds = new Set(cohort.map((m) => m.build ?? "unrecorded"));
  // One point per commit in commit order (re-measurements of a commit collapse onto its latest run),
  // so re-running an old commit later does not look like a regression in recording order.
  const byCommit = new Map<string, (typeof cohort)[number][]>();
  for (const m of cohort) byCommit.set(`${m.commitSha ?? m.id}${m.dirty ? "*" : ""}`, [...byCommit.get(`${m.commitSha ?? m.id}${m.dirty ? "*" : ""}`) ?? [], m]);
  const commitTime = (m: (typeof cohort)[number]) => m.commit?.committedAt ?? m.commit?.authoredAt ?? m.recordedAt;
  const ordered = [...byCommit.entries()].map(([key, list]) => ({ key, latest: list.at(-1)!, count: list.length }))
    .sort((a, b) => commitTime(a.latest).localeCompare(commitTime(b.latest)));
  const points = ordered.map(({ key, latest: m, count }, index) => ({
    position: index, label: key.slice(0, 7) + (m.dirty ? "*" : ""),
    subject: `${m.commit?.subject ?? ""} — ${count > 1 ? `latest of ${count} runs, ` : ""}${shortDate(m.recordedAt)} on ${m.run.machine.hostname}`,
    value: m.median, q1: m.q1, q3: m.q3, min: m.min, max: m.max, n: m.n, dirty: m.dirty ?? false,
  }));
  const medians = cohort.map((m) => m.median);
  const machine = machineList.find((entry) => entry.id === machineId);

  return (
    <div className="space-y-5">
      <Crumbs items={[
        { label: benchmark.repository.name, to: `/repositories/${benchmark.repository.id}` },
        { label: "Benchmarks", to: `/repositories/${benchmark.repository.id}/benchmarks` },
        { label: benchmark.key },
      ]} />
      <div className="flex min-w-0 items-start gap-3">
        <span className="bg-card text-muted-foreground mt-0.5 flex size-10 shrink-0 items-center justify-center rounded-xl border"><Layers className="size-5" /></span>
        <div className="min-w-0">
          <h1 className="truncate font-mono text-xl font-semibold tracking-tight">{benchmark.key}</h1>
          <p className="text-muted-foreground text-sm">{benchmark.title ?? "Untitled"} · {benchmark.cases.length} case{benchmark.cases.length === 1 ? "" : "s"}</p>
        </div>
      </div>

      <Panel>
        <div className="flex gap-1.5 overflow-x-auto p-2">
          {benchmark.cases.map((entry) => (
            <button key={entry.caseKey} type="button" onClick={() => select(entry.caseKey)}
              className={cn("grid min-w-44 gap-1 rounded-xl border px-3 py-2 text-left transition-colors",
                entry === current ? "bg-accent border-foreground/25" : "bg-well hover:border-foreground/20")}>
              <span className="flex items-center justify-between gap-3">
                <span className="truncate text-sm font-medium">{entry.caseKey}</span>
                <span className="text-muted-foreground font-mono text-[11px]">{entry.count}</span>
              </span>
              <Sparkline width={150} height={20} color="var(--info)" values={(() => {
                const clean = entry.measurements.filter((m) => !m.dirty && m.status !== "FAILED");
                const machine = primaryMachine(entry.measurements);
                return clean.filter((m) => m.run.machine.id === machine).slice(-24).map((m) => m.median);
              })()} />
              <span className="text-muted-foreground font-mono text-[10.5px]">{relativeTime(entry.lastRecordedAt)}</span>
            </button>
          ))}
        </div>
      </Panel>

      {current && <>
        <Panel>
          <StatStrip className="sm:grid-cols-2 xl:grid-cols-4">
            <Stat label="Latest median" value={duration(medians.at(-1))} detail={`${cohort.at(-1)?.commitSha?.slice(0, 7) ?? "—"} · ${machine?.hostname ?? "?"}`} />
            <Stat label="Best median" value={medians.length ? duration(Math.min(...medians)) : "—"} detail={`on ${machine?.hostname ?? "?"}${includeDirty ? " incl. dirty" : ""}`} />
            <Stat label="Measurements" value={cohort.length} unit={`/ ${all.length}`} detail={`${new Set(cohort.map((m) => m.commitSha)).size} commits in this cohort`} />
            <Stat label="Build configurations" value={builds.size} tone={builds.size > 1 ? "warn" : undefined}
              detail={builds.size > 1 ? "differing builds in this history" : [...builds][0]} />
          </StatStrip>
        </Panel>
        <Panel>
          <PanelHeader icon={History} title="History" subtitle="Median per commit in commit order on one machine · re-measured commits show their latest run · failed runs excluded · * dirty"
            actions={<>
              <div className="flex items-center gap-2">
                <Switch id="history-dirty" checked={includeDirty} onCheckedChange={(checked) => set("dirty", checked ? "1" : null)} />
                <Label htmlFor="history-dirty" className="text-muted-foreground text-xs">Dirty builds</Label>
              </div>
              <Select value={machineId ?? ""} onValueChange={(value) => set("machine", value)} disabled={machineList.length < 2}>
                <SelectTrigger size="sm" className="min-w-44"><SelectValue /></SelectTrigger>
                <SelectContent>{machineList.map((entry) => (
                  <SelectItem key={entry.id} value={entry.id}>{entry.hostname} · {entry.cpu} ({all.filter((m) => m.run.machine.id === entry.id).length})</SelectItem>
                ))}</SelectContent>
              </Select>
            </>} />
          <div className="space-y-4 px-4 pb-4">
            <Well className="px-1 pt-3 pb-1"><TrendChart points={points} reference={null} statistic="Median" /></Well>
            <Well className="divide-y overflow-hidden">
              {[...all].reverse().slice(0, 60).map((m) => (
                <Link key={m.id} to={`/runs/${m.run.id}`} className={cn("hover:bg-accent/50 grid grid-cols-[6.5rem_5rem_minmax(0,1fr)_6rem_3rem_7rem] items-center gap-3 px-3 py-1.5 text-xs",
                  !cohort.includes(m) && "opacity-45")} title={!cohort.includes(m) ? "Not in the plotted cohort (other machine, dirty or failed)" : undefined}>
                  <span className="text-muted-foreground font-mono whitespace-nowrap" title={dateTime(m.recordedAt)}>{shortDate(m.recordedAt)}</span>
                  <span className="font-mono">{m.commitSha?.slice(0, 7)}{m.dirty ? "*" : ""}</span>
                  <span className="text-muted-foreground truncate">{m.commit?.subject ?? m.run.title}</span>
                  <span className="text-right font-mono tabular-nums">{duration(m.median)}{m.status === "FAILED" ? " ✕" : ""}</span>
                  <span className="text-muted-foreground text-right font-mono">{m.n}</span>
                  <span className="text-muted-foreground truncate text-right font-mono">{m.run.machine.hostname}</span>
                </Link>
              ))}
            </Well>
          </div>
        </Panel>
      </>}

      <Panel>
        <PanelHeader icon={ListChecks} title="Runs" subtitle="Runs that measured this benchmark" />
        <div className="px-2 pb-2"><RunsTable runs={benchmark.runs} showBenchmarks={false} /></div>
      </Panel>
    </div>
  );
}
