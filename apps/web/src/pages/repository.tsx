import { useEffect, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { ChevronRight, Flame, GitBranch, GitCompare, GitPullRequest, Layers, ListChecks, Plus, Search } from "lucide-react";
import { toast } from "sonner";
import { graphql } from "@/gql";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { RunsTable } from "@/components/bench/runs-table";
import { EmptyState, ErrorState, LoadingState, NotFound } from "@/components/bench/states";
import { Crumbs, useRepositoryScope } from "@/components/shell";
import { Panel, PanelHeader, Stat, StatStrip } from "@/components/kit/panel";
import { DeltaPill, Segmented, SegmentedBar, Sparkline, verdictVar } from "@/components/kit/encodings";
import { useGraphQL, useGraphQLMutation } from "@/lib/graphql";
import { dateTime, duration, primaryMachine, relativeTime, seriesName, verdictLabel } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { RepositoryPageQuery } from "@/gql/graphql";

const RepositoryPageQueryDocument = graphql(`
  query RepositoryPage(
    $id: ID!, $pulls: Boolean!, $benchmarks: Boolean!,
    $runs: Int!, $runOffset: Int!, $runSearch: String, $profiles: Int!, $profileOffset: Int!, $profileSearch: String
  ) {
    repository(id: $id) {
      id
      slug
      name
      githubRepo
      localPath
      runCount
      profileCount
      matchingRuns: runCount(search: $runSearch)
      matchingProfiles: profileCount(search: $profileSearch)
      pullRequests @include(if: $pulls) {
        id source githubRepo number title state headRef baseRef syncedAt updatedAt author
        commits { sha }
        report { summary { series regressions improvements unchanged inconclusive failed insufficient missingHead } series { headComparison { ratio low verdict } } }
      }
      benchmarks @include(if: $benchmarks) {
        id key title
        cases { caseKey count lastRecordedAt measurements(limit: 60) { id median commitSha dirty status recordedAt run { machine { id hostname } } } }
      }
      runs(limit: $runs, offset: $runOffset, search: $runSearch) { ...RunRow }
      profiles(limit: $profiles, offset: $profileOffset, search: $profileSearch) {
        id label cpuMs samples symbolicatedShare recordedAt
        measurement { id caseKey commitSha dirty benchmark { id key } run { id title machine { hostname } } }
      }
    }
  }
`);

const TrackMutation = graphql(`
  mutation TrackPullRequest($repository: ID!, $reference: String!) {
    trackGithubPullRequest(repository: $repository, reference: $reference) { id }
  }
`);

type Repository = NonNullable<RepositoryPageQuery["repository"]>;
type PullRequest = NonNullable<Repository["pullRequests"]>[number];

interface Needs {
  pulls?: boolean;
  benchmarks?: boolean;
  runs?: number;
  runOffset?: number;
  runSearch?: string;
  profiles?: number;
  profileOffset?: number;
  profileSearch?: string;
}

/** Each page requests only what it shows (@include and limits), so navigation stays cheap. */
function useRepository(needs: Needs = {}) {
  const { id = "" } = useParams();
  const query = useGraphQL(RepositoryPageQueryDocument, {
    id, pulls: needs.pulls ?? false, benchmarks: needs.benchmarks ?? false,
    runs: needs.runs ?? 1, runOffset: needs.runOffset ?? 0, runSearch: needs.runSearch || null,
    profiles: needs.profiles ?? 1, profileOffset: needs.profileOffset ?? 0, profileSearch: needs.profileSearch || null,
  }, { placeholderData: (previous) => previous });
  useRepositoryScope(query.data?.repository?.id);
  return query;
}

function useDebounced<T>(value: T, delay = 250): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

function Pager({ offset, size, total, onChange }: { offset: number; size: number; total: number; onChange: (offset: number) => void }) {
  if (total <= size && offset === 0) return null;
  return (
    <div className="text-muted-foreground flex items-center justify-between gap-3 border-t px-4 py-2.5 text-xs">
      <span className="font-mono">{total ? `${offset + 1}–${Math.min(total, offset + size)} of ${total}` : "0 results"}</span>
      <span className="flex gap-2">
        <Button variant="outline" size="sm" disabled={offset === 0} onClick={() => onChange(Math.max(0, offset - size))}>Previous</Button>
        <Button variant="outline" size="sm" disabled={offset + size >= total} onClick={() => onChange(offset + size)}>Next</Button>
      </span>
    </div>
  );
}

function SearchBox({ value, onChange, placeholder }: { value: string; onChange: (value: string) => void; placeholder: string }) {
  return (
    <div className="relative">
      <Search className="text-muted-foreground absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2" />
      <Input value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} className="h-8 w-64 pl-8" aria-label={placeholder} />
    </div>
  );
}

function TrackPullRequest({ repository }: { repository: string }) {
  const [reference, setReference] = useState("");
  const track = useGraphQLMutation(TrackMutation);
  const navigate = useNavigate();
  return (
    <form className="flex gap-2" onSubmit={(event) => {
      event.preventDefault();
      track.mutate({ repository, reference: reference.trim() }, {
        onSuccess: (data) => navigate(`/pr/${data.trackGithubPullRequest.id}`),
        onError: (error) => toast.error(error.message),
      });
    }}>
      <Input value={reference} onChange={(event) => setReference(event.target.value)} placeholder="#123 or URL" className="h-8 w-40" />
      <Button size="sm" variant="secondary" type="submit" disabled={!reference.trim() || track.isPending}><Plus /> Track</Button>
    </form>
  );
}

function geomean(pr: PullRequest) {
  const ratios = pr.report.series.flatMap((series) => series.headComparison && series.headComparison.low !== null ? [series.headComparison.ratio] : []);
  return ratios.length ? Math.exp(ratios.reduce((sum, ratio) => sum + Math.log(ratio), 0) / ratios.length) : null;
}

const PR_GRID = "grid-cols-[minmax(10rem,1fr)_5.5rem] @md:grid-cols-[minmax(10rem,1fr)_5.5rem_5.5rem] @lg:grid-cols-[minmax(10rem,1fr)_10rem_5.5rem_5.5rem]";

function PullRequestRows({ pullRequests }: { pullRequests: PullRequest[] }) {
  if (!pullRequests.length) {
    return <EmptyState title="No tracked pull requests">Run <code>benchboard pr track 123</code> or <code>benchboard pr track --branch</code> in a checkout.</EmptyState>;
  }
  return (
    <div className="@container px-2 pb-2">
      <div className={cn("text-muted-foreground grid gap-4 px-3 pb-1.5 text-xs", PR_GRID)}>
        <span>Pull request</span><span className="hidden @lg:block">Head verdicts</span><span className="text-right">Geomean</span><span className="hidden text-right @md:block">Updated</span>
      </div>
      {pullRequests.map((pr) => {
        const s = pr.report.summary;
        const change = geomean(pr);
        return (
          <Link key={pr.id} to={`/pr/${pr.id}`} className={cn("hover:bg-accent/50 grid items-center gap-4 rounded-lg px-3 py-2.5", PR_GRID)}>
            <span className="flex min-w-0 items-center gap-3">
              <span className="bg-well text-muted-foreground flex size-8 shrink-0 items-center justify-center rounded-lg border">
                {pr.source === "GITHUB" ? <GitPullRequest className="size-4" /> : <GitBranch className="size-4" />}
              </span>
              <span className="min-w-0">
                <span className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium">{pr.title}</span>
                  {pr.number !== null && <span className="text-muted-foreground text-sm">#{pr.number}</span>}
                </span>
                <span className="text-muted-foreground block truncate font-mono text-[11px]">{pr.baseRef} ← {pr.headRef} · {pr.commits.length} commits</span>
              </span>
            </span>
            <span className="hidden gap-1.5 @lg:grid">
              <SegmentedBar legend={false} segments={(["REGRESSION", "INCONCLUSIVE", "UNCHANGED", "IMPROVEMENT"] as const).map((verdict) => ({
                key: verdict, label: verdictLabel[verdict], color: verdictVar[verdict],
                value: verdict === "REGRESSION" ? s.regressions : verdict === "IMPROVEMENT" ? s.improvements : verdict === "UNCHANGED" ? s.unchanged : s.inconclusive,
              }))} />
              <span className="text-muted-foreground flex gap-2 font-mono text-[10.5px]">
                {s.series ? <>
                  {s.regressions > 0 && <span className="text-bad">▲{s.regressions}</span>}
                  {s.improvements > 0 && <span className="text-good">▼{s.improvements}</span>}
                  <span>{s.series} series</span>
                </> : "not measured"}
              </span>
            </span>
            <span className="text-right">{change !== null ? <DeltaPill ratio={change} verdict={change > 1.02 ? "REGRESSION" : change < 0.98 ? "IMPROVEMENT" : "UNCHANGED"} /> : <span className="text-muted-foreground">—</span>}</span>
            <span className="text-muted-foreground hidden text-right text-xs @md:block">{relativeTime(pr.updatedAt ?? pr.syncedAt)}</span>
          </Link>
        );
      })}
    </div>
  );
}

type BenchmarkRow = ReturnType<typeof benchmarkRows>[number];

/** Series rows with a comparable cohort (one machine, clean and passing) and the latest step within it. */
function benchmarkRows(repository: Repository) {
  return (repository.benchmarks ?? []).flatMap((benchmark) => benchmark.cases.map((entry) => {
    // Other machines and dirty or failed builds are not comparable, so they are left out rather than joined into one line.
    const eligible = entry.measurements.filter((m) => !m.dirty && m.status !== "FAILED");
    const machine = primaryMachine(entry.measurements);
    const cohort = eligible.filter((m) => m.run.machine.id === machine).slice(-30);
    const last = cohort.at(-1) ?? entry.measurements.at(-1);
    const previous = cohort.at(-2);
    const change = last && previous && previous.median > 0 ? last.median / previous.median : null;
    return { benchmark, entry, cohort, last, change, machines: new Set(entry.measurements.map((m) => m.run.machine.id)).size };
  }));
}

const BENCH_GRID = "grid-cols-[minmax(0,1fr)_5rem_4.5rem] @md:grid-cols-[minmax(0,1fr)_8rem_5.5rem_4.5rem] @xl:grid-cols-[minmax(0,1fr)_8rem_5.5rem_4.5rem_3.5rem_6rem]";

function BenchmarkRow({ row, grouped = false }: { row: BenchmarkRow; grouped?: boolean }) {
  const { benchmark, entry, cohort, last, change, machines } = row;
  return (
    <Link to={`/benchmarks/${benchmark.id}?case=${encodeURIComponent(entry.caseKey)}`}
      className={cn("hover:bg-accent/50 grid items-center gap-4 rounded-lg px-3 py-2", BENCH_GRID, grouped && "pl-8")}>
      <span className="min-w-0">
        {!grouped && <span className="text-muted-foreground block truncate font-mono text-[11px]">{benchmark.key}</span>}
        <span className="block truncate text-sm">{entry.caseKey === "default" ? benchmark.title ?? benchmark.key : entry.caseKey}</span>
      </span>
      <span className="hidden gap-0.5 @md:grid" title={`${cohort.length} clean measurements on ${last?.run.machine.hostname ?? "?"}`}>
        {cohort.length > 1 ? <Sparkline values={cohort.map((m) => m.median)} width={128} height={20} color="var(--info)" />
          : <span className="text-muted-foreground font-mono text-[11px]">single run</span>}
        <span className="text-muted-foreground truncate font-mono text-[10px]">
          {last?.run.machine.hostname}{machines > 1 ? ` · +${machines - 1}` : ""}
        </span>
      </span>
      <span className="text-right font-mono text-sm tabular-nums">{last ? duration(last.median) : "—"}</span>
      <span className="text-right">
        {change !== null ? <DeltaPill ratio={change} digits={1} verdict={change > 1.02 ? "REGRESSION" : change < 0.98 ? "IMPROVEMENT" : "UNCHANGED"} />
          : <span className="text-muted-foreground/60 text-xs">—</span>}
      </span>
      <span className="text-muted-foreground hidden text-right font-mono text-xs @xl:block">{entry.count}</span>
      <span className="text-muted-foreground hidden text-right text-xs @xl:block">{relativeTime(entry.lastRecordedAt)}</span>
    </Link>
  );
}

function BenchmarkHeader() {
  return (
    <div className={cn("text-muted-foreground grid gap-4 px-3 pb-1.5 text-xs", BENCH_GRID)}>
      <span>Series</span><span className="hidden @md:block">Recent medians</span><span className="text-right">Latest</span>
      <span className="text-right">Δ last</span><span className="hidden text-right @xl:block">Runs</span><span className="hidden text-right @xl:block">Recorded</span>
    </div>
  );
}

function BenchmarkRows({ repository, limit }: { repository: Repository; limit?: number }) {
  const rows = benchmarkRows(repository).sort((a, b) => b.entry.lastRecordedAt.localeCompare(a.entry.lastRecordedAt)).slice(0, limit);
  if (!rows.length) return <EmptyState title="No benchmarks yet" />;
  return (
    <div className="@container px-2 pb-2">
      <BenchmarkHeader />
      {rows.map((row) => <BenchmarkRow key={`${row.benchmark.id}:${row.entry.caseKey}`} row={row} />)}
    </div>
  );
}

type BenchmarkSort = "recent" | "change" | "name";

/** Full benchmark browser: search, sort, grouping by benchmark and single-run series hidden by default. */
function BenchmarkBrowser({ repository }: { repository: Repository }) {
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<BenchmarkSort>("recent");
  const [singles, setSingles] = useState(false);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const needle = search.trim().toLowerCase();
  const all = benchmarkRows(repository);
  const rows = all.filter((row) => (singles || row.entry.count > 1) &&
    (!needle || `${row.benchmark.key} ${row.benchmark.title ?? ""} ${row.entry.caseKey}`.toLowerCase().includes(needle)));
  const order = (a: BenchmarkRow, b: BenchmarkRow) => sort === "name" ? a.entry.caseKey.localeCompare(b.entry.caseKey)
    : sort === "change" ? Math.abs((b.change ?? 1) - 1) - Math.abs((a.change ?? 1) - 1)
      : b.entry.lastRecordedAt.localeCompare(a.entry.lastRecordedAt);
  const groups = [...Map.groupBy(rows, (row) => row.benchmark.id).values()].map((list) => list.sort(order));
  groups.sort((a, b) => sort === "name" ? a[0].benchmark.key.localeCompare(b[0].benchmark.key) : order(a[0], b[0]));
  const hidden = all.length - all.filter((row) => singles || row.entry.count > 1).length;
  const toggle = (key: string) => setOpen((current) => {
    const next = new Set(current);
    next.has(key) ? next.delete(key) : next.add(key);
    return next;
  });
  return (
    <>
      <div className="flex flex-wrap items-center gap-3 px-4 pb-3">
        <SearchBox value={search} onChange={setSearch} placeholder="Benchmark, title or case…" />
        <Segmented value={sort} onChange={setSort} options={[{ value: "recent", label: "Recent" }, { value: "change", label: "Largest change" }, { value: "name", label: "Name" }]} />
        <label className="text-muted-foreground ml-auto flex items-center gap-2 text-xs">
          <Checkbox checked={singles} onCheckedChange={(checked) => setSingles(checked === true)} />
          Single-run series{hidden ? ` (${hidden} hidden)` : ""}
        </label>
      </div>
      <div className="@container px-2 pb-2">
        <BenchmarkHeader />
        {groups.map((group) => {
          const benchmark = group[0].benchmark;
          // Single-series benchmarks render flat; larger ones collapse under a header (expanded while searching).
          if (group.length === 1) return <BenchmarkRow key={benchmark.id} row={group[0]} />;
          const expanded = Boolean(needle) || open.has(benchmark.id);
          const changed = group.filter((row) => row.change !== null && Math.abs(row.change - 1) > 0.02).length;
          return (
            <div key={benchmark.id}>
              <button type="button" onClick={() => toggle(benchmark.id)} aria-expanded={expanded}
                className="hover:bg-accent/50 flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left">
                <ChevronRight className={cn("text-muted-foreground size-3.5 transition-transform", expanded && "rotate-90")} />
                <span className="font-mono text-xs font-medium">{benchmark.key}</span>
                <span className="text-muted-foreground truncate text-xs">{benchmark.title}</span>
                <span className="text-muted-foreground ml-auto font-mono text-[11px]">{group.length} series{changed ? ` · ${changed} changed` : ""}</span>
              </button>
              {expanded && group.map((row) => <BenchmarkRow key={`${benchmark.id}:${row.entry.caseKey}`} row={row} grouped />)}
            </div>
          );
        })}
        {!groups.length && <EmptyState title={needle ? "No series match" : "No benchmarks yet"} />}
      </div>
    </>
  );
}

// Names keep their space first; secondary columns appear as the card widens (container queries).
const COMPACT_GRID = "grid-cols-[minmax(8rem,1fr)_5rem] @sm:grid-cols-[minmax(8rem,1fr)_5rem_5.5rem] @md:grid-cols-[minmax(8rem,1fr)_4.5rem_5rem_5.5rem]";
const SELECTABLE_GRID = "grid-cols-[1.25rem_minmax(8rem,1fr)_5rem] @sm:grid-cols-[1.25rem_minmax(8rem,1fr)_5rem_5.5rem] @md:grid-cols-[1.25rem_minmax(8rem,1fr)_4.5rem_5rem_5.5rem] @lg:grid-cols-[1.25rem_minmax(8rem,1fr)_4.5rem_5rem_4rem_5.5rem]";

function ProfileRows({ repository, selectable = false }: { repository: Repository; selectable?: boolean }) {
  const [selected, setSelected] = useState<string[]>([]);
  const navigate = useNavigate();
  if (!repository.profiles.length) {
    return <EmptyState title="No profiles yet">Attach samply profiles with <code>benchboard profile attach &lt;run&gt;:&lt;case&gt; profile.json.gz</code>.</EmptyState>;
  }
  const toggle = (id: string) => setSelected((current) => current.includes(id) ? current.filter((entry) => entry !== id) : [...current.slice(-1), id]);
  return (
    <div className="@container px-2 pb-2">
      {selectable && (
        <div className="flex items-center gap-3 px-3 pb-2">
          <span className="text-muted-foreground text-xs">{selected.length ? `${selected.length} of 2 selected (older is base)` : "Select two profiles to compare"}</span>
          <Button size="sm" className="ml-auto" disabled={selected.length !== 2} onClick={() => {
            const [a, b] = repository.profiles.filter((profile) => selected.includes(profile.id)).reverse();
            navigate(`/profiles/compare?base=${a.id}&head=${b.id}`);
          }}><GitCompare /> Compare</Button>
        </div>
      )}
      <div className={cn("text-muted-foreground grid gap-4 px-3 pb-1.5 text-xs", selectable ? SELECTABLE_GRID : COMPACT_GRID)}>
        {selectable && <span />}<span>Series</span><span className="hidden @md:block">Commit</span><span className="text-right">CPU / iter</span>
        {selectable && <span className="hidden text-right @lg:block">Symbols</span>}<span className="hidden text-right @sm:block">Recorded</span>
      </div>
      {repository.profiles.map((profile) => {
        const m = profile.measurement;
        return (
          <div key={profile.id} className={cn("hover:bg-accent/50 grid items-center gap-4 rounded-lg px-3 py-2",
            selectable ? SELECTABLE_GRID : COMPACT_GRID, selected.includes(profile.id) && "bg-accent")}>
            {selectable && <Checkbox checked={selected.includes(profile.id)} onCheckedChange={() => toggle(profile.id)} aria-label="Select profile" />}
            <Link to={`/profiles/${profile.id}`} className="flex min-w-0 items-center gap-2.5">
              <Flame className="size-3.5 shrink-0 text-orange-500" />
              <span className="min-w-0">
                <span className="text-muted-foreground block truncate font-mono text-[11px]">{m.benchmark.key}{profile.label ? ` · ${profile.label}` : ""}</span>
                <span className="block truncate text-sm">{m.caseKey === "default" ? seriesName(m.benchmark.key, m.caseKey) : m.caseKey}</span>
              </span>
            </Link>
            <span className="hidden font-mono text-xs @md:block">{m.commitSha?.slice(0, 7) ?? "—"}{m.dirty ? "*" : ""}</span>
            <span className="text-right font-mono text-sm tabular-nums">{profile.cpuMs >= 1000 ? `${(profile.cpuMs / 1000).toFixed(2)} s` : `${profile.cpuMs.toFixed(1)} ms`}</span>
            {selectable && <span className="text-muted-foreground hidden text-right font-mono text-xs @lg:block">{(profile.symbolicatedShare * 100).toFixed(0)}%</span>}
            <span className="text-muted-foreground hidden text-right text-xs @sm:block" title={dateTime(profile.recordedAt)}>{relativeTime(profile.recordedAt)}</span>
          </div>
        );
      })}
    </div>
  );
}

function Loaded({ query, children }: { query: ReturnType<typeof useRepository>; children: (repository: Repository) => React.ReactNode }) {
  if (query.isPending) return <LoadingState rows={2} />;
  if (query.error) return <ErrorState error={query.error} />;
  if (!query.data.repository) return <NotFound what="repository" />;
  return <>{children(query.data.repository)}</>;
}

export function RepositoryOverviewPage() {
  const query = useRepository({ pulls: true, benchmarks: true, runs: 8, profiles: 1 });
  return <Loaded query={query}>{(repository) => {
    const pullRequests = repository.pullRequests ?? [];
    const benchmarks = repository.benchmarks ?? [];
    const attention = pullRequests.filter((pr) => pr.report.summary.regressions > 0).length;
    const seriesCount = benchmarks.reduce((sum, benchmark) => sum + benchmark.cases.length, 0);
    const lastRun = repository.runs[0];
    return (
      <div className="space-y-5">
        <Crumbs items={[{ label: repository.name }, { label: "Overview" }]} />
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{repository.name}</h1>
          <p className="text-muted-foreground font-mono text-xs">{repository.slug}{repository.localPath ? ` · ${repository.localPath}` : ""}</p>
        </div>
        <Panel>
          <StatStrip className="sm:grid-cols-2 xl:grid-cols-4">
            <Stat label="Runs" value={repository.runCount} detail={lastRun ? `last ${relativeTime(lastRun.recordedAt)}` : "none yet"} />
            <Stat label="Series" value={seriesCount} detail={`${benchmarks.length} benchmarks`} />
            <Stat label="PRs with regressions" value={attention} unit={`/ ${pullRequests.length}`} tone={attention ? "bad" : undefined}
              detail={pullRequests.length ? attention ? "open them from the list below" : "nothing regressed at head" : "no tracked pull requests"} />
            <Stat label="CPU profiles" value={repository.profileCount} detail={repository.profiles[0] ? `latest ${relativeTime(repository.profiles[0].recordedAt)}` : "none yet"} />
          </StatStrip>
        </Panel>
        {pullRequests.length ? (
          <Panel>
            <PanelHeader icon={GitPullRequest} title="Pull requests" subtitle="Head vs base across all measured series"
              actions={<>
                {repository.githubRepo && <TrackPullRequest repository={repository.id} />}
                <Button variant="ghost" size="sm" asChild><Link to={`/repositories/${repository.id}/pulls`}>All</Link></Button>
              </>} />
            <PullRequestRows pullRequests={pullRequests.slice(0, 8)} />
          </Panel>
        ) : (
          // An empty card would push the data down; a single line says what to do instead.
          <div className="bg-card flex flex-wrap items-center gap-3 rounded-2xl border px-4 py-3 text-sm">
            <GitPullRequest className="text-muted-foreground size-4" />
            <span className="text-muted-foreground">No tracked pull requests. Track one to see per-commit verdicts:</span>
            <code className="bg-well rounded-md border px-2 py-0.5 font-mono text-xs">benchboard pr track --branch</code>
            {repository.githubRepo && <span className="ml-auto"><TrackPullRequest repository={repository.id} /></span>}
          </div>
        )}
        <Panel>
          <PanelHeader icon={Layers} title="Benchmarks" subtitle="Most recently measured series · Δ is the latest clean measurement vs the one before on the same machine"
            actions={<Button variant="ghost" size="sm" asChild><Link to={`/repositories/${repository.id}/benchmarks`}>All</Link></Button>} />
          <BenchmarkRows repository={repository} limit={10} />
        </Panel>
        <Panel>
          <PanelHeader icon={ListChecks} title="Recent runs" subtitle="Hyperfine invocations, newest first"
            actions={<Button variant="ghost" size="sm" asChild><Link to={`/repositories/${repository.id}/runs`}>All</Link></Button>} />
          <div className="px-2 pb-2"><RunsTable runs={repository.runs} /></div>
        </Panel>
      </div>
    );
  }}</Loaded>;
}

export function PullRequestsPage() {
  const query = useRepository({ pulls: true });
  return <Loaded query={query}>{(repository) => (
    <div className="space-y-5">
      <Crumbs items={[{ label: repository.name, to: `/repositories/${repository.id}` }, { label: "Pull requests" }]} />
      <Panel>
        <PanelHeader icon={GitPullRequest} title="Pull requests" subtitle={`${repository.pullRequests?.length ?? 0} tracked · measurements attach by commit`}
          actions={repository.githubRepo && <TrackPullRequest repository={repository.id} />} />
        <PullRequestRows pullRequests={repository.pullRequests ?? []} />
      </Panel>
    </div>
  )}</Loaded>;
}

export function BenchmarksPage() {
  const query = useRepository({ benchmarks: true });
  return <Loaded query={query}>{(repository) => (
    <div className="space-y-5">
      <Crumbs items={[{ label: repository.name, to: `/repositories/${repository.id}` }, { label: "Benchmarks" }]} />
      <Panel>
        <PanelHeader icon={Layers} title="Benchmarks" subtitle={`${repository.benchmarks?.length ?? 0} benchmarks · one row per series (benchmark · case) · Δ is the latest step on the primary machine`} />
        <BenchmarkBrowser repository={repository} />
      </Panel>
    </div>
  )}</Loaded>;
}

const RUN_PAGE = 50;
const PROFILE_PAGE = 100;

/** Search and page offset live in the URL so result pages are linkable. */
function useListState() {
  const [params, setParams] = useSearchParams();
  const [text, setText] = useState(params.get("q") ?? "");
  const search = useDebounced(text);
  const offset = Number(params.get("offset") ?? 0) || 0;
  useEffect(() => {
    setParams((current) => {
      const next = new URLSearchParams(current);
      if (search) next.set("q", search); else next.delete("q");
      if ((current.get("q") ?? "") !== search) next.delete("offset");
      return next;
    }, { replace: true });
  }, [search, setParams]);
  const setOffset = (value: number) => setParams((current) => {
    const next = new URLSearchParams(current);
    if (value) next.set("offset", String(value)); else next.delete("offset");
    return next;
  }, { replace: true });
  return { text, setText, search, offset, setOffset };
}

export function RunsPage() {
  const list = useListState();
  const query = useRepository({ runs: RUN_PAGE, runOffset: list.offset, runSearch: list.search });
  return <Loaded query={query}>{(repository) => (
    <div className="space-y-5">
      <Crumbs items={[{ label: repository.name, to: `/repositories/${repository.id}` }, { label: "Runs" }]} />
      <Panel>
        <PanelHeader icon={ListChecks} title="Runs"
          subtitle={list.search ? `${repository.matchingRuns} of ${repository.runCount} runs match` : `${repository.runCount} Hyperfine runs, newest first`}
          actions={<SearchBox value={list.text} onChange={list.setText} placeholder="Title, run ID, SHA, benchmark…" />} />
        <div className="px-2 pb-2">
          {repository.runs.length ? <RunsTable runs={repository.runs} /> : <EmptyState title={list.search ? "No runs match" : "No runs yet"} />}
        </div>
        <Pager offset={list.offset} size={RUN_PAGE} total={repository.matchingRuns} onChange={list.setOffset} />
      </Panel>
    </div>
  )}</Loaded>;
}

export function ProfilesPage() {
  const list = useListState();
  const query = useRepository({ profiles: PROFILE_PAGE, profileOffset: list.offset, profileSearch: list.search });
  return <Loaded query={query}>{(repository) => (
    <div className="space-y-5">
      <Crumbs items={[{ label: repository.name, to: `/repositories/${repository.id}` }, { label: "Profiles" }]} />
      <Panel>
        <PanelHeader icon={Flame} title="Profiles"
          subtitle={`${list.search ? `${repository.matchingProfiles} of ` : ""}${repository.profileCount} samply profiles · select two to compare`}
          actions={<SearchBox value={list.text} onChange={list.setText} placeholder="Benchmark, case, label, SHA…" />} />
        <ProfileRows repository={repository} selectable />
        <Pager offset={list.offset} size={PROFILE_PAGE} total={repository.matchingProfiles} onChange={list.setOffset} />
      </Panel>
    </div>
  )}</Loaded>;
}

