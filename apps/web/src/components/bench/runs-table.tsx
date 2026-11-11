import { Link } from "react-router";
import { Flame } from "lucide-react";
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

export function RunsTable({ runs, showRepository = false, showBenchmarks = true }: { runs: RunRowFragment[]; showRepository?: boolean; showBenchmarks?: boolean }) {
  return (
    <div>
      <div className={`text-muted-foreground grid ${GRID} gap-4 px-3 pb-1.5 text-xs`}>
        <span>Run</span><span>{showBenchmarks ? "Benchmarks" : ""}</span><span>Commits</span><span className="text-right">Cases</span><span>Machine</span><span className="text-right">Recorded</span>
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
              {profiles > 0 && <span className="flex shrink-0 items-center gap-0.5 text-[11px] text-orange-500" title={`${profiles} CPU profile${profiles > 1 ? "s" : ""}`}><Flame className="size-3" />{profiles > 1 ? profiles : ""}</span>}
              {run.legacyId && <span className="text-muted-foreground/70 shrink-0 font-mono text-[10.5px]" title="Imported from pi /bench history">pi</span>}
            </span>
            {showBenchmarks ? <span className="text-muted-foreground truncate font-mono text-[11px]">{benchmarks.join(", ")}</span> : <span />}
            <span className="text-muted-foreground flex min-w-0 items-center gap-1.5 truncate font-mono text-[11px]">
              {commits.slice(0, 2).join(", ")}{commits.length > 2 ? ` +${commits.length - 2}` : ""}
              {dirty && <span className="size-1.5 shrink-0 rounded-full bg-[var(--warn)]" title="Includes dirty builds" />}
            </span>
            <span className="text-right font-mono text-xs tabular-nums">{run.measurements.length}</span>
            <span className="text-muted-foreground truncate font-mono text-[11px]">{run.machine.hostname}</span>
            <span className="text-muted-foreground text-right text-xs" title={dateTime(run.recordedAt)}>{relativeTime(run.recordedAt)}</span>
          </Link>
        );
      })}
    </div>
  );
}
