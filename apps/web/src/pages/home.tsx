import { Link } from "react-router";
import { Activity, FolderGit2, GitBranch, GitPullRequest, Rocket } from "lucide-react";
import { graphql } from "@/gql";
import { Checklist, Command } from "@/components/kit/onboarding";
import { Panel, PanelHeader } from "@/components/kit/panel";
import { DeltaPill, SegmentedBar, verdictVar } from "@/components/kit/encodings";
import { ErrorState, LoadingState } from "@/components/bench/states";
import { Crumbs } from "@/components/shell";
import { useGraphQL } from "@/lib/graphql";
import { relativeTime, verdictLabel } from "@/lib/format";

const HomeQuery = graphql(`
  query HomeAttention {
    repositories {
      id name slug runCount profileCount
      benchmarks { id }
      pullRequests {
        id title number source headRef baseRef updatedAt syncedAt
        report { summary { series regressions improvements unchanged inconclusive insufficient missingHead } series { headComparison { ratio low } } }
      }
    }
  }
`);

/** Commands for a first ingest, shared by the empty states. */
export const gettingStartedSteps = (state: { tracked: boolean; measured: boolean; profiled: boolean }) => [
  {
    title: "Track a pull request or branch", done: state.tracked,
    description: "Run in your checkout. GitHub PRs need the gh CLI; local branches use git.",
    command: "benchboard pr track --branch            # or: benchboard pr track 1234",
  },
  {
    title: "Ingest a Hyperfine run attributed to commits", done: state.measured,
    description: <>Measure the base and head builds in one invocation and record which commit each case measured (a <code>--meta</code> file can name cases and commits per case).</>,
    command: "hyperfine --export-json q1.json './base/bin q1' './head/bin q1'\nbenchboard ingest q1.json --benchmark tpch/sf1 --meta meta.json",
  },
  {
    title: "Optionally attach a CPU profile", done: state.profiled,
    description: "samply profiles explain where time went: flame graphs and per-commit differential flame graphs.",
    command: "samply record --save-only --unstable-presymbolicate -o q1.json.gz ./head/bin q1\nbenchboard profile attach <run-id>:2 q1.json.gz",
  },
];

/** Cross-repository landing: the pull requests that need a look first. */
export function HomePage() {
  const query = useGraphQL(HomeQuery, {});
  if (query.isPending) return <LoadingState rows={1} />;
  if (query.error) return <ErrorState error={query.error} />;
  const repositories = query.data.repositories;
  if (!repositories.length) {
    return (
      <div className="mx-auto max-w-2xl space-y-5 py-6">
        <Crumbs items={[{ label: "Getting started" }]} />
        <Checklist icon={Rocket} title="Get started with Benchboard" steps={gettingStartedSteps({ tracked: false, measured: false, profiled: false })}
          footer={<div className="space-y-2 text-sm"><span className="text-muted-foreground">Just looking? Load a synthetic PR with profiles from the benchboard checkout:</span>
            <Command>BENCHBOARD_HOME=/tmp/benchboard-demo bun run seed:demo</Command></div>} />
      </div>
    );
  }
  const pulls = repositories.flatMap((repository) => repository.pullRequests.map((pr) => ({ ...pr, repository })));
  const score = (s: (typeof pulls)[number]["report"]["summary"]) => s.regressions * 1000 + s.inconclusive * 10 + s.insufficient + (s.series ? 0 : -1);
  pulls.sort((a, b) => score(b.report.summary) - score(a.report.summary) || (b.updatedAt ?? b.syncedAt).localeCompare(a.updatedAt ?? a.syncedAt));
  return (
    <div className="space-y-5">
      <Crumbs items={[{ label: "Home" }]} />
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Needs attention</h1>
        <p className="text-muted-foreground text-sm">Tracked pull requests across {repositories.length} repositor{repositories.length === 1 ? "y" : "ies"}, regressions first.</p>
      </div>
      <Panel>
        <PanelHeader icon={GitPullRequest} title="Pull requests" subtitle={`${pulls.length} tracked`} />
        {pulls.length ? (
          <div className="px-2 pb-2">
            {pulls.map((pr) => {
              const s = pr.report.summary;
              const ratios = pr.report.series.flatMap((series) => series.headComparison && series.headComparison.low !== null ? [series.headComparison.ratio] : []);
              const geomean = ratios.length ? Math.exp(ratios.reduce((sum, ratio) => sum + Math.log(ratio), 0) / ratios.length) : null;
              return (
                <Link key={pr.id} to={`/pr/${pr.id}`} className="hover:bg-accent/50 grid grid-cols-[minmax(0,1fr)_9rem_5.5rem_6rem] items-center gap-4 rounded-lg px-3 py-2.5">
                  <span className="flex min-w-0 items-center gap-3">
                    <span className="bg-well text-muted-foreground flex size-8 shrink-0 items-center justify-center rounded-lg border">
                      {pr.source === "GITHUB" ? <GitPullRequest className="size-4" /> : <GitBranch className="size-4" />}
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium">{pr.title}{pr.number !== null && <span className="text-muted-foreground font-normal"> #{pr.number}</span>}</span>
                      <span className="text-muted-foreground block truncate font-mono text-[11px]">{pr.repository.name} · {pr.baseRef} ← {pr.headRef}</span>
                    </span>
                  </span>
                  <span className="grid gap-1.5">
                    <SegmentedBar legend={false} segments={(["REGRESSION", "INCONCLUSIVE", "UNCHANGED", "IMPROVEMENT"] as const).map((verdict) => ({
                      key: verdict, label: verdictLabel[verdict], color: verdictVar[verdict],
                      value: { REGRESSION: s.regressions, INCONCLUSIVE: s.inconclusive, UNCHANGED: s.unchanged, IMPROVEMENT: s.improvements }[verdict],
                    }))} />
                    <span className="text-muted-foreground font-mono text-[10.5px]">
                      {s.series ? <>{s.regressions ? <span className="text-bad">{s.regressions} slower · </span> : null}{s.improvements ? <span className="text-good">{s.improvements} faster · </span> : null}{s.series} series</> : "not measured yet"}
                    </span>
                  </span>
                  <span className="text-right">{geomean !== null ? <DeltaPill ratio={geomean} verdict={geomean > 1.02 ? "REGRESSION" : geomean < 0.98 ? "IMPROVEMENT" : "UNCHANGED"} /> : <span className="text-muted-foreground">—</span>}</span>
                  <span className="text-muted-foreground text-right text-xs">{relativeTime(pr.updatedAt ?? pr.syncedAt)}</span>
                </Link>
              );
            })}
          </div>
        ) : (
          <div className="px-4 pb-4 text-sm">
            <p className="text-muted-foreground mb-2">No pull requests are tracked yet. In a checkout:</p>
            <Command>benchboard pr track --branch            # or: benchboard pr track 1234</Command>
          </div>
        )}
      </Panel>
      <Panel>
        <PanelHeader icon={FolderGit2} title="Repositories" subtitle="Recorded benchmarks by repository" />
        <div className="grid gap-2 px-4 pb-4 sm:grid-cols-2 xl:grid-cols-3">
          {repositories.map((repository) => (
            <Link key={repository.id} to={`/repositories/${repository.id}`} className="bg-well hover:border-foreground/20 grid gap-1 rounded-xl border px-3 py-2.5 transition-colors">
              <span className="flex items-center gap-2 text-sm font-medium"><Activity className="text-muted-foreground size-3.5" />{repository.name}</span>
              <span className="text-muted-foreground truncate font-mono text-[11px]">{repository.slug}</span>
              <span className="text-muted-foreground font-mono text-[11px]">{repository.runCount} runs · {repository.benchmarks.length} benchmarks · {repository.pullRequests.length} PRs · {repository.profileCount} profiles</span>
            </Link>
          ))}
        </div>
      </Panel>
    </div>
  );
}
