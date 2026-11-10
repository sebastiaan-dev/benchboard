import { useState } from "react";
import { Link, useParams } from "react-router";
import { graphql } from "@/gql";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from "@/components/ui/breadcrumb";
import { TrendChart } from "@/components/bench/series-charts";
import { ErrorState, LoadingState, NotFound } from "@/components/bench/states";
import { RunsTable } from "@/components/bench/runs-table";
import { useGraphQL } from "@/lib/graphql";
import { dateTime, duration } from "@/lib/format";

const BenchmarkQuery = graphql(`
  query Benchmark($id: ID!) {
    benchmark(id: $id) {
      id
      key
      title
      description
      repository { id slug }
      cases {
        caseKey
        count
        measurements(limit: 300) {
          id label median mean q1 q3 min max n dirty status commitSha recordedAt
          commit { subject }
          run { id title machine { hostname } }
        }
      }
      runs(limit: 20) { ...RunRow }
    }
  }
`);

export function BenchmarkPage() {
  const { id = "" } = useParams();
  const [caseKey, setCaseKey] = useState<string | null>(null);
  const query = useGraphQL(BenchmarkQuery, { id });
  if (query.isPending) return <LoadingState rows={2} />;
  if (query.error) return <ErrorState error={query.error} />;
  const benchmark = query.data.benchmark;
  if (!benchmark) return <NotFound what="benchmark" />;
  const current = benchmark.cases.find((entry) => entry.caseKey === caseKey) ?? benchmark.cases[0];
  const points = current?.measurements.map((m, index) => ({
    position: index, label: `${m.commitSha?.slice(0, 7) ?? "?"}${m.dirty ? "*" : ""}`,
    subject: `${m.commit?.subject ?? ""} — ${dateTime(m.recordedAt)} on ${m.run.machine.hostname}`,
    value: m.median, q1: m.q1, q3: m.q3, min: m.min, max: m.max, n: m.n, dirty: m.dirty ?? false,
  })) ?? [];
  return (
    <div className="space-y-6">
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem><BreadcrumbLink asChild><Link to="/">Repositories</Link></BreadcrumbLink></BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem><BreadcrumbLink asChild><Link to={`/repositories/${benchmark.repository.id}`}>{benchmark.repository.slug}</Link></BreadcrumbLink></BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem><BreadcrumbPage>{benchmark.key}</BreadcrumbPage></BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>
      <div>
        <h1 className="font-mono text-2xl font-semibold tracking-tight">{benchmark.key}</h1>
        {benchmark.title && <p className="text-muted-foreground">{benchmark.title}</p>}
      </div>
      {current && (
        <Card>
          <CardHeader>
            <CardTitle>History</CardTitle>
            <CardDescription>Median of every measurement in recording order; labels are commits (* dirty). Mixed machines are not comparable.</CardDescription>
            <CardAction>
              <Select value={current.caseKey} onValueChange={setCaseKey}>
                <SelectTrigger size="sm" className="min-w-40"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {benchmark.cases.map((entry) => <SelectItem key={entry.caseKey} value={entry.caseKey}>{entry.caseKey} ({entry.count})</SelectItem>)}
                </SelectContent>
              </Select>
            </CardAction>
          </CardHeader>
          <CardContent>
            <TrendChart points={points} reference={null} statistic="Median" />
            <Table className="mt-4">
              <TableHeader>
                <TableRow>
                  <TableHead>Recorded</TableHead>
                  <TableHead>Commit</TableHead>
                  <TableHead className="text-right">Median</TableHead>
                  <TableHead className="text-right">n</TableHead>
                  <TableHead>Machine</TableHead>
                  <TableHead>Run</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {[...current.measurements].reverse().slice(0, 50).map((m) => (
                  <TableRow key={m.id}>
                    <TableCell className="text-muted-foreground text-xs">{dateTime(m.recordedAt)}</TableCell>
                    <TableCell className="max-w-72 truncate"><span className="font-mono text-xs">{m.commitSha?.slice(0, 7)}{m.dirty ? " +dirty" : ""}</span> <span className="text-muted-foreground text-xs">{m.commit?.subject}</span></TableCell>
                    <TableCell className="text-right font-mono tabular-nums">{duration(m.median)}</TableCell>
                    <TableCell className="text-right tabular-nums">{m.n}</TableCell>
                    <TableCell className="text-muted-foreground text-xs">{m.run.machine.hostname}</TableCell>
                    <TableCell><Link to={`/runs/${m.run.id}`} className="text-xs hover:underline">{m.run.title ?? m.run.id}</Link></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
      <Card>
        <CardHeader><CardTitle>Runs</CardTitle></CardHeader>
        <CardContent><RunsTable runs={benchmark.runs} /></CardContent>
      </Card>
    </div>
  );
}
