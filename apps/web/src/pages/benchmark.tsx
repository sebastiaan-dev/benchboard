import { useParams, useSearchParams, Link } from "react-router";
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
import { dateTime, duration, relativeTime } from "@/lib/format";
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
          id label median mean q1 q3 min max n dirty status commitSha recordedAt
          commit { subject }
          run { id title machine { hostname } }
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
  const points = current?.measurements.map((m, index) => ({
    position: index, label: `${m.commitSha?.slice(0, 7) ?? "?"}${m.dirty ? "*" : ""}`,
    subject: `${m.commit?.subject ?? ""} — ${dateTime(m.recordedAt)} on ${m.run.machine.hostname}`,
    value: m.median, q1: m.q1, q3: m.q3, min: m.min, max: m.max, n: m.n, dirty: m.dirty ?? false,
  })) ?? [];
  const medians = current?.measurements.map((m) => m.median) ?? [];
  const machines = new Set(current?.measurements.map((m) => m.run.machine.hostname));

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
              <Sparkline values={entry.measurements.slice(-24).map((m) => m.median)} width={150} height={20} color="var(--info)" />
              <span className="text-muted-foreground font-mono text-[10.5px]">{relativeTime(entry.lastRecordedAt)}</span>
            </button>
          ))}
        </div>
      </Panel>

      {current && <>
        <Panel>
          <StatStrip className="sm:grid-cols-2 xl:grid-cols-4">
            <Stat label="Latest median" value={duration(medians.at(-1))} detail={current.measurements.at(-1)?.commitSha?.slice(0, 7)} />
            <Stat label="Best median" value={duration(Math.min(...medians))} />
            <Stat label="Measurements" value={current.count} detail={`${new Set(current.measurements.map((m) => m.commitSha)).size} commits`} />
            <Stat label="Machines" value={machines.size} tone={machines.size > 1 ? "warn" : undefined} detail={machines.size > 1 ? "mixed machines are not comparable" : [...machines][0]} />
          </StatStrip>
        </Panel>
        <Panel>
          <PanelHeader icon={History} title="History" subtitle="Median of every measurement in recording order · labels are commits (* dirty)"
            actions={benchmark.cases.length > 1 && (
              <Select value={current.caseKey} onValueChange={select}>
                <SelectTrigger size="sm" className="min-w-40"><SelectValue /></SelectTrigger>
                <SelectContent>{benchmark.cases.map((entry) => <SelectItem key={entry.caseKey} value={entry.caseKey}>{entry.caseKey} ({entry.count})</SelectItem>)}</SelectContent>
              </Select>
            )} />
          <div className="space-y-4 px-4 pb-4">
            <Well className="px-1 pt-3 pb-1"><TrendChart points={points} reference={null} statistic="Median" /></Well>
            <Well className="divide-y overflow-hidden">
              {[...current.measurements].reverse().slice(0, 40).map((m) => (
                <Link key={m.id} to={`/runs/${m.run.id}`} className="hover:bg-accent/50 grid grid-cols-[9rem_5rem_minmax(0,1fr)_6rem_3rem_7rem] items-center gap-3 px-3 py-1.5 text-xs">
                  <span className="text-muted-foreground font-mono">{dateTime(m.recordedAt)}</span>
                  <span className="font-mono">{m.commitSha?.slice(0, 7)}{m.dirty ? "*" : ""}</span>
                  <span className="text-muted-foreground truncate">{m.commit?.subject ?? m.run.title}</span>
                  <span className="text-right font-mono tabular-nums">{duration(m.median)}</span>
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
        <div className="px-2 pb-2"><RunsTable runs={benchmark.runs} /></div>
      </Panel>
    </div>
  );
}
