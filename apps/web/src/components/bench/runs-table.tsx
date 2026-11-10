import { Link } from "react-router";
import { graphql } from "@/gql";
import { Pill, verdictVar } from "@/components/kit/encodings";
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
    measurements { id status commitSha dirty benchmark { key } profiles { id } }
  }
`);

const GRID = "grid-cols-[minmax(0,1fr)_minmax(0,11rem)_8rem_3.5rem_7rem_6rem]";

export function RunsTable({ runs, showRepository = false }: { runs: RunRowFragment[]; showRepository?: boolean }) {
  return (
    <div>
      <div className={`text-muted-foreground grid ${GRID} gap-4 px-3 pb-1.5 font-mono text-[10px] tracking-wide uppercase`}>
        <span>Run</span><span>Benchmarks</span><span>Commits</span><span className="text-right">Cases</span><span>Machine</span><span className="text-right">Recorded</span>
      </div>
      {runs.map((run) => {
        const benchmarks = [...new Set(run.measurements.map((m) => m.benchmark.key))];
        const commits = [...new Set(run.measurements.map((m) => m.commitSha?.slice(0, 7) ?? "—"))];
        const failed = run.measurements.filter((m) => m.status === "FAILED").length;
        const dirty = run.measurements.some((m) => m.dirty);
        const profiles = run.measurements.reduce((sum, m) => sum + m.profiles.length, 0);
        return (
          <Link key={run.id} to={`/runs/${run.id}`} className={`hover:bg-accent/50 grid ${GRID} items-center gap-4 rounded-lg px-3 py-2`}>
            <span className="flex min-w-0 items-center gap-2">
              <span className="truncate text-sm">{run.title ?? run.id}</span>
              {showRepository && <span className="text-muted-foreground truncate text-xs">{run.repository.name}</span>}
              {failed > 0 && <Pill color={verdictVar.FAILED} className="h-5 text-[10.5px]">{failed} failed</Pill>}
              {dirty && <Pill color="var(--warn)" className="h-5 text-[10.5px]">dirty</Pill>}
              {profiles > 0 && <Pill color="oklch(0.72 0.17 50)" className="h-5 text-[10.5px]">{profiles} profile{profiles > 1 ? "s" : ""}</Pill>}
              {run.legacyId && <Pill className="h-5 text-[10.5px]">imported</Pill>}
            </span>
            <span className="text-muted-foreground truncate font-mono text-[11px]">{benchmarks.join(", ")}</span>
            <span className="text-muted-foreground truncate font-mono text-[11px]">{commits.slice(0, 2).join(", ")}{commits.length > 2 ? ` +${commits.length - 2}` : ""}</span>
            <span className="text-right font-mono text-xs tabular-nums">{run.measurements.length}</span>
            <span className="text-muted-foreground truncate font-mono text-[11px]">{run.machine.hostname}</span>
            <span className="text-muted-foreground text-right text-xs" title={dateTime(run.recordedAt)}>{relativeTime(run.recordedAt)}</span>
          </Link>
        );
      })}
    </div>
  );
}
