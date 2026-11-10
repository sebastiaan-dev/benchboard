import { useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { Download, ExternalLink, Flame, GitCompare } from "lucide-react";
import { functionStats, mergeThreads, sampleMs, type CallTree } from "@benchboard/core/profile-tree";
import { graphql } from "@/gql";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from "@/components/ui/breadcrumb";
import { FlameGraph, fromCallTree } from "@/components/bench/flame-graph";
import { ErrorState, Hint, LoadingState, NotFound } from "@/components/bench/states";
import { useGraphQL } from "@/lib/graphql";
import { dateTime, seriesName } from "@/lib/format";

export const ProfileHeaderFields = graphql(`
  fragment ProfileHeader on Profile {
    id
    label
    product
    samples
    intervalMs
    iterations
    cpuMs
    durationMs
    symbolicatedShare
    hasSymbols
    nodeCount
    command
    recordedAt
    rawPath
    threads { name samples }
    measurement {
      id
      position
      caseKey
      label
      commitSha
      dirty
      median
      commit { shortSha subject url }
      benchmark { id key title repository { id slug } }
      run { id title recordedAt machine { hostname cpu } }
    }
  }
`);

const ProfileQuery = graphql(`
  query Profile($id: ID!, $origin: String!) {
    profile(id: $id) {
      ...ProfileHeader
      tree
      firefoxProfilerUrl(origin: $origin)
      related { id label cpuMs measurement { commitSha dirty run { title recordedAt } } }
    }
  }
`);

export function ms(value: number) {
  const size = Math.abs(value);
  return size >= 1000 ? `${(value / 1000).toFixed(2)} s` : `${value.toFixed(size >= 100 ? 0 : size >= 10 ? 1 : 2)} ms`;
}

/** Applies the thread selection: either the per-thread tree, or threads merged into one. */
export function useThreadView(tree: CallTree | undefined) {
  const [merge, setMerge] = useState(true);
  const [thread, setThread] = useState<string>("all");
  const view = useMemo(() => {
    if (!tree) return undefined;
    if (thread !== "all") return mergeThreads(tree, new Set([thread]));
    return merge ? mergeThreads(tree) : tree;
  }, [tree, merge, thread]);
  return { view, merge, setMerge, thread, setThread };
}

export function ThreadControls({ tree, state }: { tree: CallTree; state: ReturnType<typeof useThreadView> }) {
  return (
    <div className="flex flex-wrap items-center gap-4">
      <div className="flex items-center gap-2">
        <Label className="text-muted-foreground text-xs">Thread</Label>
        <Select value={state.thread} onValueChange={state.setThread}>
          <SelectTrigger size="sm" className="min-w-44"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All threads ({tree.threads.length})</SelectItem>
            {tree.threads.map((thread) => (
              <SelectItem key={thread.name} value={thread.name}>{thread.name} · {((thread.samples / tree.samples) * 100).toFixed(1)}%</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {state.thread === "all" && (
        <div className="flex items-center gap-2">
          <Switch id="merge" checked={state.merge} onCheckedChange={state.setMerge} />
          <Label htmlFor="merge" className="text-muted-foreground text-xs">Merge threads</Label>
        </div>
      )}
    </div>
  );
}

export function ProfilePage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [rows, setRows] = useState(50);
  const [sort, setSort] = useState<"self" | "total">("self");
  const query = useGraphQL(ProfileQuery, { id, origin: window.location.origin });
  const profile = query.data?.profile;
  const tree = profile?.tree as CallTree | undefined;
  const threads = useThreadView(tree);
  const root = useMemo(() => threads.view && profile ? fromCallTree(threads.view, sampleMs(threads.view, profile.iterations)) : undefined, [threads.view, profile]);
  const stats = useMemo(() => threads.view ? functionStats(threads.view).sort((a, b) => b[sort] - a[sort]).slice(0, 1000) : [], [threads.view, sort]);

  if (query.isPending) return <LoadingState rows={2} />;
  if (query.error) return <ErrorState error={query.error} />;
  if (!profile || !tree || !root || !threads.view) return <NotFound what="profile" />;
  const m = profile.measurement;
  const scale = sampleMs(threads.view, profile.iterations);

  return (
    <div className="space-y-6">
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem><BreadcrumbLink asChild><Link to="/">Repositories</Link></BreadcrumbLink></BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem><BreadcrumbLink asChild><Link to={`/repositories/${m.benchmark.repository.id}`}>{m.benchmark.repository.slug}</Link></BreadcrumbLink></BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem><BreadcrumbLink asChild><Link to={`/runs/${m.run.id}`}>{m.run.title ?? m.run.id}</Link></BreadcrumbLink></BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem><BreadcrumbPage>Profile {profile.id}</BreadcrumbPage></BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <Flame className="size-6 text-orange-500" /> {seriesName(m.benchmark.key, m.caseKey)}
            {profile.label && <Badge variant="outline">{profile.label}</Badge>}
          </h1>
          <p className="text-muted-foreground text-sm">
            <span className="font-mono">{m.commit?.shortSha.slice(0, 7) ?? "no commit"}{m.dirty ? "+dirty" : ""}</span>
            {m.commit?.subject && <> · {m.commit.subject}</>} · {m.run.machine.hostname} · recorded {dateTime(profile.recordedAt)}
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" asChild>
            <a href={profile.rawPath} download><Download /> Raw profile</a>
          </Button>
          <Hint content="Loads this profile in profiler.firefox.com, which fetches it and its symbols from this local server. Chrome may ask to allow local network access.">
            <Button variant="outline" size="sm" asChild>
              <a href={profile.firefoxProfilerUrl} target="_blank" rel="noreferrer"><ExternalLink /> Firefox Profiler</a>
            </Button>
          </Hint>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        {[
          ["CPU / iteration", ms(profile.cpuMs)],
          ["Measured median", m.median ? ms(m.median * 1000) : "—"],
          ["Samples", `${profile.samples.toLocaleString()} @ ${profile.intervalMs} ms`],
          ["Threads", String(profile.threads.length)],
          ["Symbolicated", `${(profile.symbolicatedShare * 100).toFixed(1)}%`],
        ].map(([label, value]) => (
          <Card key={label} className="gap-1 py-4">
            <CardContent className="px-4">
              <div className="text-muted-foreground text-xs font-medium uppercase tracking-wide">{label}</div>
              <div className="mt-1 text-xl font-semibold tabular-nums">{value}</div>
            </CardContent>
          </Card>
        ))}
      </div>
      {!profile.hasSymbols && profile.symbolicatedShare < 0.9 && (
        <p className="text-sm text-amber-700 dark:text-amber-300">
          Most frames are unsymbolicated. Record with <code>samply record --save-only --unstable-presymbolicate</code> so the
          <code> .syms.json</code> sidecar is attached, or open the profile in the Firefox Profiler.
        </p>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Flame graph</CardTitle>
          <CardDescription>Widths are CPU time per iteration; inlined functions are expanded. Click to zoom.</CardDescription>
          <CardAction className="flex items-center gap-2">
            {profile.related.length > 0 && (
              <Select onValueChange={(other) => navigate(`/profiles/compare?base=${other}&head=${profile.id}`)}>
                <SelectTrigger size="sm" className="min-w-56"><GitCompare className="size-4" /><SelectValue placeholder="Compare with…" /></SelectTrigger>
                <SelectContent>
                  {profile.related.map((other) => (
                    <SelectItem key={other.id} value={other.id}>
                      {other.measurement.commitSha?.slice(0, 7) ?? "?"}{other.measurement.dirty ? "+dirty" : ""} · {ms(other.cpuMs)} · {other.measurement.run.title ?? dateTime(other.measurement.run.recordedAt)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </CardAction>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <ThreadControls tree={tree} state={threads} />
            <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Highlight functions…" className="h-8 w-64" />
          </div>
          <FlameGraph root={root} search={search} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Hottest functions</CardTitle>
          <CardDescription>Self: samples in the function itself. Total: samples with it anywhere on the stack (recursion counted once).</CardDescription>
          <CardAction>
            <ToggleGroup type="single" size="sm" variant="outline" value={sort} onValueChange={(value) => value && setSort(value as "self" | "total")}>
              <ToggleGroupItem value="self">Self</ToggleGroupItem>
              <ToggleGroupItem value="total">Total</ToggleGroupItem>
            </ToggleGroup>
          </CardAction>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-28 text-right">Self</TableHead>
                <TableHead className="w-28 text-right">Total</TableHead>
                <TableHead>Function</TableHead>
                <TableHead>Library</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {stats.slice(0, rows).map((stat) => (
                <TableRow key={`${stat.name}\0${stat.library}`} className="cursor-pointer" onClick={() => setSearch(stat.name)}>
                  <TableCell className="text-right font-mono tabular-nums">
                    {ms(stat.self * scale)} <span className="text-muted-foreground text-xs">{((stat.self / threads.view!.samples) * 100).toFixed(1)}%</span>
                  </TableCell>
                  <TableCell className="text-right font-mono tabular-nums">
                    {ms(stat.total * scale)} <span className="text-muted-foreground text-xs">{((stat.total / threads.view!.samples) * 100).toFixed(1)}%</span>
                  </TableCell>
                  <TableCell className="max-w-[48rem] truncate font-mono text-xs" title={stat.name}>{stat.name}</TableCell>
                  <TableCell className="text-muted-foreground text-xs">{stat.library}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {stats.length > rows && (
            <Button variant="ghost" size="sm" className="mt-2" onClick={() => setRows(rows + 100)}>Show more ({stats.length - rows} hidden)</Button>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
