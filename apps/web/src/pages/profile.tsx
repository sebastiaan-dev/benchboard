import { useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { Download, ExternalLink, Flame, GitCompare, ListOrdered } from "lucide-react";
import { functionStats, sampleMs, type CallTree } from "@benchboard/core/profile-tree";
import { graphql } from "@/gql";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { FlameGraph, fromCallTree } from "@/components/bench/flame-graph";
import { ThreadControls, ms, useThreadView } from "@/components/bench/profile-tools";
import { ErrorState, Hint, LoadingState, NotFound } from "@/components/bench/states";
import { Crumbs, useRepositoryScope } from "@/components/shell";
import { Panel, PanelHeader, Stat, StatStrip, Well } from "@/components/kit/panel";
import { Pill, Segmented } from "@/components/kit/encodings";
import { useGraphQL } from "@/lib/graphql";
import { dateTime, seriesName } from "@/lib/format";

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

export function ProfilePage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<"self" | "total">("self");
  const [rows, setRows] = useState(40);
  const query = useGraphQL(ProfileQuery, { id, origin: window.location.origin });
  const profile = query.data?.profile;
  const tree = profile?.tree as CallTree | undefined;
  const threads = useThreadView(tree);
  useRepositoryScope(profile?.measurement.benchmark.repository.id);
  const root = useMemo(() => threads.view && profile ? fromCallTree(threads.view, sampleMs(threads.view, profile.iterations)) : undefined, [threads.view, profile]);
  const stats = useMemo(() => threads.view ? functionStats(threads.view).sort((a, b) => b[sort] - a[sort]).slice(0, 1000) : [], [threads.view, sort]);

  if (query.isPending) return <LoadingState rows={2} />;
  if (query.error) return <ErrorState error={query.error} />;
  if (!profile || !tree || !root || !threads.view) return <NotFound what="profile" />;
  const m = profile.measurement;
  const scale = sampleMs(threads.view, profile.iterations);
  const repository = m.benchmark.repository;
  const maxSelf = Math.max(1, ...stats.slice(0, rows).map((stat) => stat[sort]));

  return (
    <div className="space-y-5">
      <Crumbs items={[
        { label: repository.name, to: `/repositories/${repository.id}` },
        { label: "Profiles", to: `/repositories/${repository.id}/profiles` },
        { label: `${seriesName(m.benchmark.key, m.caseKey)} @ ${m.commitSha?.slice(0, 7) ?? "?"}` },
      ]} />
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <span className="bg-card mt-0.5 flex size-10 shrink-0 items-center justify-center rounded-xl border"><Flame className="size-5 text-orange-500" /></span>
          <div className="min-w-0 space-y-1">
            <div className="flex items-center gap-2">
              <h1 className="truncate text-xl font-semibold tracking-tight">{seriesName(m.benchmark.key, m.caseKey)}</h1>
              {profile.label && <Pill>{profile.label}</Pill>}
            </div>
            <p className="text-muted-foreground truncate font-mono text-xs">
              {m.commit?.shortSha.slice(0, 7) ?? "no commit"}{m.dirty ? "+dirty" : ""}{m.commit?.subject ? ` · ${m.commit.subject}` : ""} · {m.run.machine.hostname} · {dateTime(profile.recordedAt)} · <Link to={`/runs/${m.run.id}`} className="hover:text-foreground underline-offset-4 hover:underline">{m.run.title ?? m.run.id}</Link>
            </p>
          </div>
        </div>
        <div className="flex gap-2">
          {profile.related.length > 0 && (
            <Select onValueChange={(other) => navigate(`/profiles/compare?base=${other}&head=${profile.id}`)}>
              <SelectTrigger size="sm" className="min-w-52"><GitCompare className="size-4" /><SelectValue placeholder="Compare with…" /></SelectTrigger>
              <SelectContent>
                {profile.related.map((other) => (
                  <SelectItem key={other.id} value={other.id}>
                    {other.measurement.commitSha?.slice(0, 7) ?? "?"}{other.measurement.dirty ? "+dirty" : ""} · {ms(other.cpuMs)} · {other.measurement.run.title ?? dateTime(other.measurement.run.recordedAt)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <Button variant="outline" size="sm" asChild><a href={profile.rawPath} download><Download /> Raw</a></Button>
          <Hint content="Loads this profile in profiler.firefox.com, which fetches it and its symbols from this local server. Chrome may ask to allow local network access.">
            <Button variant="outline" size="sm" asChild><a href={profile.firefoxProfilerUrl} target="_blank" rel="noreferrer"><ExternalLink /> Firefox Profiler</a></Button>
          </Hint>
        </div>
      </div>

      <Panel>
        <StatStrip className="sm:grid-cols-3 xl:grid-cols-5">
          <Stat label="CPU / iteration" value={ms(profile.cpuMs)} detail={`${profile.iterations} iteration${profile.iterations > 1 ? "s" : ""} · all threads`} />
          <Stat label="Wall median (hyperfine)" value={m.median ? ms(m.median * 1000) : "—"} detail="from the measured case" />
          <Stat label="Samples" value={profile.samples.toLocaleString()} detail={`every ${profile.intervalMs} ms`} />
          <Stat label="Threads" value={profile.threads.length} detail={profile.threads[0]?.name} />
          <Stat label="Symbolicated" value={`${(profile.symbolicatedShare * 100).toFixed(1)}%`} tone={profile.symbolicatedShare < 0.9 ? "warn" : undefined}
            detail={profile.hasSymbols ? ".syms.json sidecar" : "no sidecar"} />
        </StatStrip>
      </Panel>

      <Panel>
        <PanelHeader icon={Flame} title="Flame graph" subtitle="Widths are CPU time per iteration · inlined frames expanded · click to zoom"
          actions={<Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Highlight functions…" className="h-8 w-56" />} />
        <div className="space-y-3 px-4 pb-4">
          <ThreadControls tree={tree} state={threads} />
          <FlameGraph root={root} search={search} />
        </div>
      </Panel>

      <Panel>
        <PanelHeader icon={ListOrdered} title="Hottest functions" subtitle="Self: in the function itself · Total: anywhere on the stack (recursion counted once)"
          actions={<Segmented value={sort} onChange={setSort} options={[{ value: "self", label: "Self" }, { value: "total", label: "Total" }]} />} />
        <div className="px-4 pb-4">
          <Well className="overflow-hidden">
            {stats.slice(0, rows).map((stat) => (
              <button type="button" key={`${stat.name}\0${stat.library}`} onClick={() => setSearch(stat.name)}
                className="hover:bg-accent/50 grid w-full grid-cols-[5.5rem_5.5rem_minmax(0,1fr)_8rem] items-center gap-3 border-b px-3 py-1.5 text-left last:border-b-0">
                <span className="text-right font-mono text-xs tabular-nums">{ms(stat.self * scale)}</span>
                <span className="text-muted-foreground text-right font-mono text-xs tabular-nums">{ms(stat.total * scale)}</span>
                <span className="relative min-w-0">
                  <span className="absolute inset-y-0.5 left-0 rounded-sm bg-orange-500/20" style={{ width: `${(stat[sort] / maxSelf) * 100}%` }} />
                  <span className="relative block truncate px-1 font-mono text-xs" title={stat.name}>{stat.name}</span>
                </span>
                <span className="text-muted-foreground truncate text-right font-mono text-[11px]">{stat.library}</span>
              </button>
            ))}
          </Well>
          {stats.length > rows && <Button variant="ghost" size="sm" className="mt-2" onClick={() => setRows(rows + 100)}>Show more ({stats.length - rows} more)</Button>}
        </div>
      </Panel>
    </div>
  );
}
