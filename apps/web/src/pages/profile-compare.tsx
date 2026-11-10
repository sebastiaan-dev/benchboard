import { useMemo, useState, type SetStateAction } from "react";
import { Link, useSearchParams } from "react-router";
import { ArrowRight } from "lucide-react";
import { diffFunctions, diffTrees, type CallTree } from "@benchboard/core/profile-tree";
import { graphql } from "@/gql";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { FlameGraph, diffColor, fromDiffTree } from "@/components/bench/flame-graph";
import { ErrorState, LoadingState, NotFound } from "@/components/bench/states";
import { useGraphQL } from "@/lib/graphql";
import { seriesName } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { ProfileHeaderFragment } from "@/gql/graphql";
import { ms, ThreadControls, useThreadView } from "./profile";

const CompareQuery = graphql(`
  query ProfileCompare($base: ID!, $head: ID!) {
    base: profile(id: $base) { ...ProfileHeader tree }
    head: profile(id: $head) { ...ProfileHeader tree }
  }
`);

function Side({ title, profile }: { title: string; profile: ProfileHeaderFragment }) {
  const m = profile.measurement;
  return (
    <Link to={`/profiles/${profile.id}`} className="hover:bg-muted/50 grid min-w-0 flex-1 gap-0.5 rounded-lg border p-3">
      <span className="text-muted-foreground text-xs font-medium uppercase tracking-wide">{title}</span>
      <span className="font-mono text-sm">{m.commit?.shortSha.slice(0, 7) ?? "no commit"}{m.dirty ? "+dirty" : ""}</span>
      <span className="text-muted-foreground truncate text-xs">{m.commit?.subject ?? m.run.title}</span>
      <span className="text-lg font-semibold tabular-nums">{ms(profile.cpuMs)} <span className="text-muted-foreground text-xs font-normal">CPU / iteration</span></span>
    </Link>
  );
}

const change = (base: number, head: number) => {
  const delta = head - base;
  return (
    <span className={cn("font-mono tabular-nums", delta > 0 ? "text-red-600 dark:text-red-400" : delta < 0 ? "text-blue-600 dark:text-blue-400" : "text-muted-foreground")}>
      {delta >= 0 ? "+" : ""}{ms(delta)}
    </span>
  );
};

/** Differential profile: which functions gained or lost CPU time between two profiles of a case. */
export function ProfileComparePage() {
  const [params] = useSearchParams();
  const base = params.get("base") ?? "";
  const head = params.get("head") ?? "";
  const query = useGraphQL(CompareQuery, { base, head }, { enabled: Boolean(base && head) });
  const [side, setSide] = useState<"head" | "base">("head");
  const [search, setSearch] = useState("");
  const baseTree = query.data?.base?.tree as CallTree | undefined;
  const headTree = query.data?.head?.tree as CallTree | undefined;
  const baseThreads = useThreadView(baseTree);
  const headThreads = useThreadView(headTree);
  // One thread selection drives both sides so the comparison stays like-for-like.
  const syncedHead = headThreads.view;
  const iterations = { base: query.data?.base?.iterations ?? 1, head: query.data?.head?.iterations ?? 1 };
  const diff = useMemo(() => baseThreads.view && syncedHead ? diffTrees(baseThreads.view, syncedHead, iterations) : undefined,
    [baseThreads.view, syncedHead, iterations.base, iterations.head]);
  const root = useMemo(() => diff ? fromDiffTree(diff, side) : undefined, [diff, side]);
  const functions = useMemo(() => baseThreads.view && syncedHead ? diffFunctions(baseThreads.view, syncedHead, iterations).slice(0, 150) : [],
    [baseThreads.view, syncedHead, iterations.base, iterations.head]);

  if (!base || !head) return <NotFound what="comparison" />;
  if (query.isPending) return <LoadingState rows={2} />;
  if (query.error) return <ErrorState error={query.error} />;
  const { base: a, head: b } = query.data;
  if (!a || !b || !baseTree || !root) return <NotFound what="profile" />;
  const setThread = (value: SetStateAction<string>) => { baseThreads.setThread(value); headThreads.setThread(value); };
  const setMerge = (value: SetStateAction<boolean>) => { baseThreads.setMerge(value); headThreads.setMerge(value); };
  const total = a.cpuMs ? b.cpuMs / a.cpuMs : 1;

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Profile comparison</h1>
        <p className="text-muted-foreground text-sm">
          {seriesName(b.measurement.benchmark.key, b.measurement.caseKey)}
          {a.measurement.benchmark.key !== b.measurement.benchmark.key || a.measurement.caseKey !== b.measurement.caseKey
            ? <> vs {seriesName(a.measurement.benchmark.key, a.measurement.caseKey)} (different series)</> : null}
          {a.measurement.run.machine.hostname !== b.measurement.run.machine.hostname && <> · ⚠ recorded on different machines</>}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Side title="Base" profile={a} />
        <ArrowRight className="text-muted-foreground size-5 shrink-0" />
        <Side title="Head" profile={b} />
        <Card className="min-w-48 flex-none gap-1 py-3">
          <CardContent className="px-4">
            <div className="text-muted-foreground text-xs font-medium uppercase tracking-wide">CPU time change</div>
            <div className={cn("text-2xl font-semibold tabular-nums", total > 1.02 ? "text-red-600 dark:text-red-400" : total < 0.98 ? "text-blue-600 dark:text-blue-400" : "")}>
              {total >= 1 ? "+" : ""}{((total - 1) * 100).toFixed(1)}%
            </div>
            <div className="text-muted-foreground text-xs">{change(a.cpuMs, b.cpuMs)} per iteration</div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Differential flame graph</CardTitle>
          <CardDescription>
            Frames are merged by call path. Red frames take more CPU time in head, blue frames less (inclusive time per iteration).
            Widths follow the {side} profile; switch to base to see code that disappeared.
          </CardDescription>
          <CardAction>
            <ToggleGroup type="single" size="sm" variant="outline" value={side} onValueChange={(value) => value && setSide(value as "head" | "base")}>
              <ToggleGroupItem value="head">Head widths</ToggleGroupItem>
              <ToggleGroupItem value="base">Base widths</ToggleGroupItem>
            </ToggleGroup>
          </CardAction>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <ThreadControls tree={baseTree} state={{ ...baseThreads, setThread, setMerge }} />
            <div className="flex items-center gap-3">
              <div className="text-muted-foreground flex items-center gap-1 text-xs">
                less <span className="flex h-3 w-24 overflow-hidden rounded-sm">
                  {[-1, -0.6, -0.3, 0, 0.3, 0.6, 1].map((value) => (
                    <span key={value} className="flex-1" style={{ background: diffColor(1, 1 + value) }} />
                  ))}
                </span> more
              </div>
              <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Highlight functions…" className="h-8 w-56" />
            </div>
          </div>
          <FlameGraph root={root} diff search={search} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Function changes</CardTitle>
          <CardDescription>Sorted by change in self time (CPU ms per iteration). Shares are of each profile's samples.</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-right">Δ self</TableHead>
                <TableHead className="text-right">Base self</TableHead>
                <TableHead className="text-right">Head self</TableHead>
                <TableHead className="text-right">Δ total</TableHead>
                <TableHead>Function</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {functions.map((entry) => (
                <TableRow key={`${entry.name}\0${entry.library}`} className="cursor-pointer" onClick={() => setSearch(entry.name)}>
                  <TableCell className="text-right">{change(entry.baseSelfMs, entry.headSelfMs)}</TableCell>
                  <TableCell className="text-right font-mono tabular-nums">
                    {ms(entry.baseSelfMs)} <span className="text-muted-foreground text-xs">{(entry.baseSelfShare * 100).toFixed(1)}%</span>
                  </TableCell>
                  <TableCell className="text-right font-mono tabular-nums">
                    {ms(entry.headSelfMs)} <span className="text-muted-foreground text-xs">{(entry.headSelfShare * 100).toFixed(1)}%</span>
                  </TableCell>
                  <TableCell className="text-right">{change(entry.baseTotalMs, entry.headTotalMs)}</TableCell>
                  <TableCell className="max-w-[44rem] truncate font-mono text-xs" title={`${entry.name}${entry.library ? ` (${entry.library})` : ""}`}>
                    {entry.name} {entry.library && <span className="text-muted-foreground">· {entry.library}</span>}
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
