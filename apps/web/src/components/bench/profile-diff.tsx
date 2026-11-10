import { useMemo, useState, type SetStateAction } from "react";
import { Link } from "react-router";
import { ArrowRight, Flame, GitCompare } from "lucide-react";
import { diffFunctions, diffTrees, type CallTree } from "@benchboard/core/profile-tree";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FlameGraph, diffColor, fromDiffTree } from "@/components/bench/flame-graph";
import { ProfilePairQuery, ThreadControls, ms, useThreadView } from "@/components/bench/profile-tools";
import { ErrorState, NotFound } from "@/components/bench/states";
import { MicroLabel, Panel, PanelHeader, Well } from "@/components/kit/panel";
import { Segmented } from "@/components/kit/encodings";
import { Skeleton } from "@/components/ui/skeleton";
import { useGraphQL } from "@/lib/graphql";
import { cn } from "@/lib/utils";
import type { ProfileHeaderFragment } from "@/gql/graphql";

function Side({ title, profile }: { title: string; profile: ProfileHeaderFragment }) {
  const m = profile.measurement;
  return (
    <Link to={`/profiles/${profile.id}`} className="bg-well hover:border-foreground/20 grid min-w-0 flex-1 gap-1 rounded-xl border p-3 transition-colors">
      <MicroLabel>{title}</MicroLabel>
      <span className="truncate text-sm">
        <span className="font-mono">{m.commit?.shortSha.slice(0, 7) ?? "no commit"}{m.dirty ? "+dirty" : ""}</span>
        <span className="text-muted-foreground"> · {m.commit?.subject ?? m.run.title}</span>
      </span>
      <span className="text-xl font-semibold tracking-tight tabular-nums">{ms(profile.cpuMs)} <span className="text-muted-foreground text-xs font-normal">CPU / iteration</span></span>
    </Link>
  );
}

function Delta({ value }: { value: number }) {
  return (
    <span className={cn("font-mono text-xs tabular-nums", value > 0 ? "text-bad" : value < 0 ? "text-info" : "text-muted-foreground")}>
      {value >= 0 ? "+" : ""}{ms(value)}
    </span>
  );
}

/**
 * Differential profile between two profiles of a case: CPU time per iteration, a differential
 * flame graph merged by call path, and per-function changes with diverging bars.
 */
export function ProfileDiffView({ baseId, headId, inline = false }: { baseId: string; headId: string; inline?: boolean }) {
  const query = useGraphQL(ProfilePairQuery, { base: baseId, head: headId });
  const [side, setSide] = useState<"head" | "base">("head");
  const [search, setSearch] = useState("");
  const [rows, setRows] = useState(inline ? 8 : 40);
  const baseTree = query.data?.base?.tree as CallTree | undefined;
  const headTree = query.data?.head?.tree as CallTree | undefined;
  const baseThreads = useThreadView(baseTree);
  const headThreads = useThreadView(headTree);
  const iterations = { base: query.data?.base?.iterations ?? 1, head: query.data?.head?.iterations ?? 1 };
  const diff = useMemo(() => baseThreads.view && headThreads.view ? diffTrees(baseThreads.view, headThreads.view, iterations) : undefined,
    [baseThreads.view, headThreads.view, iterations.base, iterations.head]);
  const root = useMemo(() => diff ? fromDiffTree(diff, side) : undefined, [diff, side]);
  const functions = useMemo(() => baseThreads.view && headThreads.view ? diffFunctions(baseThreads.view, headThreads.view, iterations).slice(0, 1000) : [],
    [baseThreads.view, headThreads.view, iterations.base, iterations.head]);

  if (query.isPending) return <Skeleton className="h-96 rounded-2xl" />;
  if (query.error) return <ErrorState error={query.error} />;
  const { base: a, head: b } = query.data;
  if (!a || !b || !baseTree || !root) return <NotFound what="profile" />;
  // One thread selection drives both sides so the comparison stays like-for-like.
  const threads = {
    ...baseThreads,
    setThread: (value: SetStateAction<string>) => { baseThreads.setThread(value); headThreads.setThread(value); },
    setMerge: (value: SetStateAction<boolean>) => { baseThreads.setMerge(value); headThreads.setMerge(value); },
  };
  const total = a.cpuMs ? b.cpuMs / a.cpuMs : 1;
  const maxDelta = Math.max(1e-9, ...functions.slice(0, rows).map((entry) => Math.abs(entry.headSelfMs - entry.baseSelfMs)));
  const crossMachine = a.measurement.run.machine.hostname !== b.measurement.run.machine.hostname;

  return (
    <Panel>
      <PanelHeader
        icon={GitCompare}
        title={inline ? "Where the time went" : "Differential profile"}
        subtitle={`Merged by call path · CPU ms per iteration${crossMachine ? " · ⚠ recorded on different machines" : ""}`}
        actions={<>
          {inline && <Button variant="outline" size="sm" asChild><Link to={`/profiles/compare?base=${a.id}&head=${b.id}`}>Open full comparison</Link></Button>}
          <Segmented value={side} onChange={setSide} options={[{ value: "head", label: "Head widths" }, { value: "base", label: "Base widths" }]} />
        </>}
      />
      <div className="space-y-4 px-4 pb-4">
        <div className="flex flex-wrap items-stretch gap-3">
          <Side title="Base" profile={a} />
          <ArrowRight className="text-muted-foreground size-4 shrink-0 self-center" />
          <Side title="Head" profile={b} />
          <div className="bg-well grid min-w-40 content-start gap-1 rounded-xl border p-3">
            <MicroLabel>CPU time change</MicroLabel>
            <span className={cn("text-2xl font-semibold tracking-tight tabular-nums", total > 1.02 ? "text-bad" : total < 0.98 ? "text-good" : "")}>
              {total >= 1 ? "+" : ""}{((total - 1) * 100).toFixed(1)}%
            </span>
            <Delta value={b.cpuMs - a.cpuMs} />
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <ThreadControls tree={baseTree} state={threads} />
          <div className="flex items-center gap-3">
            <div className="text-muted-foreground flex items-center gap-1.5 font-mono text-[10.5px] uppercase">
              less
              <span className="flex h-2 w-20 overflow-hidden rounded-full">
                {[-1, -0.6, -0.3, 0, 0.3, 0.6, 1].map((value) => <span key={value} className="flex-1" style={{ background: diffColor(1, 1 + value) }} />)}
              </span>
              more
            </div>
            <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Highlight functions…" className="h-8 w-52" />
          </div>
        </div>
        <FlameGraph root={root} diff search={search} />
        <Well className="overflow-hidden">
          <div className="text-muted-foreground grid grid-cols-[6.5rem_1fr_5.5rem_5.5rem] gap-3 border-b px-3 py-2 font-mono text-[10.5px] tracking-wide uppercase">
            <span className="text-right">Δ self</span><span>Function</span><span className="text-right">Base</span><span className="text-right">Head</span>
          </div>
          {functions.slice(0, rows).map((entry) => {
            const delta = entry.headSelfMs - entry.baseSelfMs;
            const width = `${(Math.abs(delta) / maxDelta) * 50}%`;
            return (
              <button type="button" key={`${entry.name}\0${entry.library}`} onClick={() => setSearch(entry.name)}
                className="hover:bg-accent/50 grid w-full grid-cols-[6.5rem_1fr_5.5rem_5.5rem] items-center gap-3 border-b px-3 py-1.5 text-left last:border-b-0">
                <span className="text-right"><Delta value={delta} /></span>
                <span className="relative min-w-0">
                  {/* Diverging bar centred on the column: right for more time, left for less. */}
                  <span className="absolute inset-y-0 left-1/2 w-px bg-border" />
                  <span className="absolute inset-y-0.5 rounded-sm opacity-30"
                    style={{ background: delta > 0 ? "var(--bad)" : "var(--info)", width, ...(delta > 0 ? { left: "50%" } : { right: "50%" }) }} />
                  <span className="relative block truncate font-mono text-xs" title={`${entry.name}${entry.library ? ` · ${entry.library}` : ""}`}>{entry.name}</span>
                </span>
                <span className="text-muted-foreground text-right font-mono text-xs tabular-nums">{ms(entry.baseSelfMs)}</span>
                <span className="text-right font-mono text-xs tabular-nums">{ms(entry.headSelfMs)}</span>
              </button>
            );
          })}
        </Well>
        {functions.length > rows && (
          <Button variant="ghost" size="sm" onClick={() => setRows(rows + (inline ? 20 : 100))}>
            <Flame /> Show more functions ({functions.length - rows} more)
          </Button>
        )}
      </div>
    </Panel>
  );
}
