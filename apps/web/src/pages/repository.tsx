import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { Flame, GitBranch, GitCompare, GitPullRequest, Layers, ListChecks, Plus } from "lucide-react";
import { toast } from "sonner";
import { graphql } from "@/gql";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { RunsTable } from "@/components/bench/runs-table";
import { EmptyState, ErrorState, LoadingState, NotFound } from "@/components/bench/states";
import { Crumbs, useRepositoryScope } from "@/components/shell";
import { Panel, PanelHeader, Stat, StatStrip } from "@/components/kit/panel";
import { DeltaPill, SegmentedBar, Sparkline, verdictVar } from "@/components/kit/encodings";
import { useGraphQL, useGraphQLMutation } from "@/lib/graphql";
import { dateTime, duration, primaryMachine, relativeTime, seriesName, verdictLabel } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { RepositoryPageQuery } from "@/gql/graphql";

const RepositoryPageQueryDocument = graphql(`
  query RepositoryPage($id: ID!, $runs: Int!, $profiles: Int!) {
    repository(id: $id) {
      id
      slug
      name
      githubRepo
      localPath
      runCount
      pullRequests {
        id source githubRepo number title state headRef baseRef syncedAt updatedAt author
        commits { sha }
        report { summary { series regressions improvements unchanged inconclusive failed insufficient missingHead } series { headComparison { ratio low verdict } } }
      }
      benchmarks {
        id key title
        cases { caseKey count lastRecordedAt measurements(limit: 60) { id median commitSha dirty status recordedAt run { machine { id hostname } } } }
      }
      runs(limit: $runs) { ...RunRow }
      profiles(limit: $profiles) {
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
type PullRequest = Repository["pullRequests"][number];

function useRepository(limits: { runs?: number; profiles?: number } = {}) {
  const { id = "" } = useParams();
  const query = useGraphQL(RepositoryPageQueryDocument, { id, runs: limits.runs ?? 10, profiles: limits.profiles ?? 8 });
  useRepositoryScope(query.data?.repository?.id);
  return query;
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

function PullRequestRows({ pullRequests }: { pullRequests: PullRequest[] }) {
  if (!pullRequests.length) {
    return <EmptyState title="No tracked pull requests">Run <code>benchboard pr track 123</code> or <code>benchboard pr track --branch</code> in a checkout.</EmptyState>;
  }
  return (
    <div className="px-2 pb-2">
      <div className="text-muted-foreground grid grid-cols-[minmax(0,1fr)_10rem_5.5rem_5.5rem] gap-4 px-3 pb-1.5 font-mono text-[10px] tracking-wide uppercase">
        <span>Pull request</span><span>Verdicts</span><span className="text-right">Geomean</span><span className="text-right">Updated</span>
      </div>
      {pullRequests.map((pr) => {
        const s = pr.report.summary;
        const change = geomean(pr);
        return (
          <Link key={pr.id} to={`/pr/${pr.id}`} className="hover:bg-accent/50 grid grid-cols-[minmax(0,1fr)_10rem_5.5rem_5.5rem] items-center gap-4 rounded-lg px-3 py-2.5">
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
            <span className="grid gap-1.5">
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
            <span className="text-muted-foreground text-right text-xs">{relativeTime(pr.updatedAt ?? pr.syncedAt)}</span>
          </Link>
        );
      })}
    </div>
  );
}

function BenchmarkRows({ repository, limit }: { repository: Repository; limit?: number }) {
  const rows = repository.benchmarks.flatMap((benchmark) => benchmark.cases.map((entry) => ({ benchmark, entry })))
    .sort((a, b) => b.entry.lastRecordedAt.localeCompare(a.entry.lastRecordedAt)).slice(0, limit);
  if (!rows.length) return <EmptyState title="No benchmarks yet" />;
  return (
    <div className="px-2 pb-2">
      <div className="text-muted-foreground grid grid-cols-[minmax(0,1fr)_8rem_6rem_4rem_6rem] gap-4 px-3 pb-1.5 font-mono text-[10px] tracking-wide uppercase">
        <span>Series</span><span>Recent medians</span><span className="text-right">Latest</span><span className="text-right">Runs</span><span className="text-right">Recorded</span>
      </div>
      {rows.map(({ benchmark, entry }) => {
        // One cohort per sparkline: the latest clean, passing measurement's machine. Other machines and
        // dirty or failed builds are not comparable, so they are left out rather than joined into one line.
        const eligible = entry.measurements.filter((m) => !m.dirty && m.status !== "FAILED");
        const machine = primaryMachine(entry.measurements);
        const cohort = eligible.filter((m) => m.run.machine.id === machine).slice(-30);
        const last = cohort.at(-1) ?? entry.measurements.at(-1);
        const machines = new Set(entry.measurements.map((m) => m.run.machine.id)).size;
        return (
          <Link key={`${benchmark.id}:${entry.caseKey}`} to={`/benchmarks/${benchmark.id}?case=${encodeURIComponent(entry.caseKey)}`}
            className="hover:bg-accent/50 grid grid-cols-[minmax(0,1fr)_8rem_6rem_4rem_6rem] items-center gap-4 rounded-lg px-3 py-2">
            <span className="min-w-0">
              <span className="text-muted-foreground block truncate font-mono text-[11px]">{benchmark.key}</span>
              <span className="block truncate text-sm">{entry.caseKey === "default" ? benchmark.title ?? benchmark.key : entry.caseKey}</span>
            </span>
            <span className="grid gap-0.5" title={`${cohort.length} clean measurements on ${last?.run.machine.hostname ?? "?"}`}>
              <Sparkline values={cohort.map((m) => m.median)} width={128} height={22} color="var(--info)" />
              <span className="text-muted-foreground truncate font-mono text-[10px]">
                {last?.run.machine.hostname}{machines > 1 ? ` · +${machines - 1} other machine${machines > 2 ? "s" : ""}` : ""}
              </span>
            </span>
            <span className="text-right font-mono text-sm tabular-nums">{last ? duration(last.median) : "—"}</span>
            <span className="text-muted-foreground text-right font-mono text-xs">{entry.count}</span>
            <span className="text-muted-foreground text-right text-xs">{relativeTime(entry.lastRecordedAt)}</span>
          </Link>
        );
      })}
    </div>
  );
}

function ProfileRows({ repository, selectable = false }: { repository: Repository; selectable?: boolean }) {
  const [selected, setSelected] = useState<string[]>([]);
  const navigate = useNavigate();
  if (!repository.profiles.length) {
    return <EmptyState title="No profiles yet">Attach samply profiles with <code>benchboard profile attach &lt;run&gt;:&lt;case&gt; profile.json.gz</code>.</EmptyState>;
  }
  const toggle = (id: string) => setSelected((current) => current.includes(id) ? current.filter((entry) => entry !== id) : [...current.slice(-1), id]);
  return (
    <div className="px-2 pb-2">
      {selectable && (
        <div className="flex items-center gap-3 px-3 pb-2">
          <span className="text-muted-foreground text-xs">{selected.length ? `${selected.length} of 2 selected (older is base)` : "Select two profiles to compare"}</span>
          <Button size="sm" className="ml-auto" disabled={selected.length !== 2} onClick={() => {
            const [a, b] = repository.profiles.filter((profile) => selected.includes(profile.id)).reverse();
            navigate(`/profiles/compare?base=${a.id}&head=${b.id}`);
          }}><GitCompare /> Compare</Button>
        </div>
      )}
      <div className={cn("text-muted-foreground grid gap-4 px-3 pb-1.5 font-mono text-[10px] tracking-wide uppercase",
        selectable ? "grid-cols-[1.25rem_minmax(0,1fr)_5.5rem_6rem_5rem_6rem]" : "grid-cols-[minmax(0,1fr)_5.5rem_6rem_6rem]")}>
        {selectable && <span />}<span>Series</span><span>Commit</span><span className="text-right">CPU / iter</span>{selectable && <span className="text-right">Symbols</span>}<span className="text-right">Recorded</span>
      </div>
      {repository.profiles.map((profile) => {
        const m = profile.measurement;
        return (
          <div key={profile.id} className={cn("hover:bg-accent/50 grid items-center gap-4 rounded-lg px-3 py-2",
            selectable ? "grid-cols-[1.25rem_minmax(0,1fr)_5.5rem_6rem_5rem_6rem]" : "grid-cols-[minmax(0,1fr)_5.5rem_6rem_6rem]",
            selected.includes(profile.id) && "bg-accent")}>
            {selectable && <Checkbox checked={selected.includes(profile.id)} onCheckedChange={() => toggle(profile.id)} aria-label="Select profile" />}
            <Link to={`/profiles/${profile.id}`} className="flex min-w-0 items-center gap-2.5">
              <Flame className="size-3.5 shrink-0 text-orange-500" />
              <span className="min-w-0">
                <span className="text-muted-foreground block truncate font-mono text-[11px]">{m.benchmark.key}{profile.label ? ` · ${profile.label}` : ""}</span>
                <span className="block truncate text-sm">{m.caseKey === "default" ? seriesName(m.benchmark.key, m.caseKey) : m.caseKey}</span>
              </span>
            </Link>
            <span className="font-mono text-xs">{m.commitSha?.slice(0, 7) ?? "—"}{m.dirty ? "*" : ""}</span>
            <span className="text-right font-mono text-sm tabular-nums">{profile.cpuMs >= 1000 ? `${(profile.cpuMs / 1000).toFixed(2)} s` : `${profile.cpuMs.toFixed(1)} ms`}</span>
            {selectable && <span className="text-muted-foreground text-right font-mono text-xs">{(profile.symbolicatedShare * 100).toFixed(0)}%</span>}
            <span className="text-muted-foreground text-right text-xs" title={dateTime(profile.recordedAt)}>{relativeTime(profile.recordedAt)}</span>
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
  const query = useRepository({ runs: 8, profiles: 6 });
  return <Loaded query={query}>{(repository) => {
    const attention = repository.pullRequests.filter((pr) => pr.report.summary.regressions > 0).length;
    const seriesCount = repository.benchmarks.reduce((sum, benchmark) => sum + benchmark.cases.length, 0);
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
            <Stat label="Series" value={seriesCount} detail={`${repository.benchmarks.length} benchmarks`} />
            <Stat label="Tracked pull requests" value={repository.pullRequests.length} tone={attention ? "bad" : undefined}
              detail={attention ? `${attention} with regressions` : "no regressions"} />
            <Stat label="CPU profiles" value={repository.profiles.length} detail={repository.profiles[0] ? `latest ${relativeTime(repository.profiles[0].recordedAt)}` : "none yet"} />
          </StatStrip>
        </Panel>
        <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
          <Panel>
            <PanelHeader icon={GitPullRequest} title="Pull requests" subtitle="Head vs base across all measured series"
              actions={<>
                {repository.githubRepo && <TrackPullRequest repository={repository.id} />}
                <Button variant="ghost" size="sm" asChild><Link to={`/repositories/${repository.id}/pulls`}>All</Link></Button>
              </>} />
            <PullRequestRows pullRequests={repository.pullRequests.slice(0, 8)} />
          </Panel>
          <Panel>
            <PanelHeader icon={Flame} title="Recent profiles" subtitle="samply flame graphs attached to measurements"
              actions={<Button variant="ghost" size="sm" asChild><Link to={`/repositories/${repository.id}/profiles`}>All</Link></Button>} />
            <ProfileRows repository={repository} />
          </Panel>
        </div>
        <Panel>
          <PanelHeader icon={Layers} title="Benchmarks" subtitle="Most recently measured series"
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
  const query = useRepository({ runs: 1, profiles: 1 });
  return <Loaded query={query}>{(repository) => (
    <div className="space-y-5">
      <Crumbs items={[{ label: repository.name, to: `/repositories/${repository.id}` }, { label: "Pull requests" }]} />
      <Panel>
        <PanelHeader icon={GitPullRequest} title="Pull requests" subtitle={`${repository.pullRequests.length} tracked · measurements attach by commit`}
          actions={repository.githubRepo && <TrackPullRequest repository={repository.id} />} />
        <PullRequestRows pullRequests={repository.pullRequests} />
      </Panel>
    </div>
  )}</Loaded>;
}

export function BenchmarksPage() {
  const query = useRepository({ runs: 1, profiles: 1 });
  return <Loaded query={query}>{(repository) => (
    <div className="space-y-5">
      <Crumbs items={[{ label: repository.name, to: `/repositories/${repository.id}` }, { label: "Benchmarks" }]} />
      <Panel>
        <PanelHeader icon={Layers} title="Benchmarks" subtitle={`${repository.benchmarks.length} benchmarks · one row per series (benchmark · case)`} />
        <BenchmarkRows repository={repository} />
      </Panel>
    </div>
  )}</Loaded>;
}

export function RunsPage() {
  const query = useRepository({ runs: 200, profiles: 1 });
  return <Loaded query={query}>{(repository) => (
    <div className="space-y-5">
      <Crumbs items={[{ label: repository.name, to: `/repositories/${repository.id}` }, { label: "Runs" }]} />
      <Panel>
        <PanelHeader icon={ListChecks} title="Runs" subtitle={`${repository.runCount} Hyperfine runs${repository.runCount > 200 ? " · newest 200 shown" : ""}`} />
        <div className="px-2 pb-2"><RunsTable runs={repository.runs} /></div>
      </Panel>
    </div>
  )}</Loaded>;
}

export function ProfilesPage() {
  const query = useRepository({ runs: 1, profiles: 500 });
  return <Loaded query={query}>{(repository) => (
    <div className="space-y-5">
      <Crumbs items={[{ label: repository.name, to: `/repositories/${repository.id}` }, { label: "Profiles" }]} />
      <Panel>
        <PanelHeader icon={Flame} title="Profiles" subtitle={`${repository.profiles.length} samply profiles · select two to compare`} />
        <ProfileRows repository={repository} selectable />
      </Panel>
    </div>
  )}</Loaded>;
}

