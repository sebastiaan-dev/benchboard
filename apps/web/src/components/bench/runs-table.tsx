import { Link } from "react-router";
import { graphql } from "@/gql";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { dateTime, relativeTime } from "@/lib/format";
import type { RunRowFragment } from "@/gql/graphql";

export const RunRow = graphql(`
  fragment RunRow on Run {
    id
    title
    recordedAt
    legacyId
    repository { id name }
    machine { hostname }
    measurements { id status commitSha dirty benchmark { key } }
  }
`);

export function RunsTable({ runs, showRepository = false }: { runs: RunRowFragment[]; showRepository?: boolean }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Run</TableHead>
          {showRepository && <TableHead>Repository</TableHead>}
          <TableHead>Benchmarks</TableHead>
          <TableHead>Commits</TableHead>
          <TableHead className="text-right">Cases</TableHead>
          <TableHead>Machine</TableHead>
          <TableHead className="text-right">Recorded</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {runs.map((run) => {
          const benchmarks = [...new Set(run.measurements.map((m) => m.benchmark.key))];
          const commits = [...new Set(run.measurements.map((m) => m.commitSha?.slice(0, 7) ?? "—"))];
          const failed = run.measurements.filter((m) => m.status === "FAILED").length;
          const dirty = run.measurements.some((m) => m.dirty);
          return (
            <TableRow key={run.id}>
              <TableCell className="max-w-96">
                <Link to={`/runs/${run.id}`} className="block truncate font-medium hover:underline">{run.title ?? run.id}</Link>
                <div className="flex gap-1.5">
                  {run.legacyId && <Badge variant="secondary" className="text-[10px]">imported</Badge>}
                  {failed > 0 && <Badge variant="destructive" className="text-[10px]">{failed} failed</Badge>}
                  {dirty && <Badge variant="outline" className="border-amber-500/40 text-[10px] text-amber-700 dark:text-amber-300">dirty</Badge>}
                </div>
              </TableCell>
              {showRepository && <TableCell><Link to={`/repositories/${run.repository.id}`} className="hover:underline">{run.repository.name}</Link></TableCell>}
              <TableCell className="text-muted-foreground max-w-56 truncate font-mono text-xs">{benchmarks.join(", ")}</TableCell>
              <TableCell className="text-muted-foreground max-w-40 truncate font-mono text-xs">{commits.slice(0, 3).join(", ")}{commits.length > 3 ? ` +${commits.length - 3}` : ""}</TableCell>
              <TableCell className="text-right tabular-nums">{run.measurements.length}</TableCell>
              <TableCell className="text-muted-foreground text-xs">{run.machine.hostname}</TableCell>
              <TableCell className="text-muted-foreground text-right text-xs" title={dateTime(run.recordedAt)}>{relativeTime(run.recordedAt)}</TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
