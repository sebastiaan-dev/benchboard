import { Link } from "react-router";
import { FolderGit2 } from "lucide-react";
import { graphql } from "@/gql";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState, ErrorState, LoadingState } from "@/components/bench/states";
import { RunsTable } from "@/components/bench/runs-table";
import { useGraphQL } from "@/lib/graphql";
import { relativeTime } from "@/lib/format";

const HomeQuery = graphql(`
  query Home {
    repositories {
      id
      slug
      name
      runCount
      pullRequests { id title source number headRef syncedAt updatedAt }
      benchmarks { id }
    }
    runs(limit: 15) { ...RunRow }
  }
`);

export function HomePage() {
  const query = useGraphQL(HomeQuery, {});
  if (query.isPending) return <LoadingState rows={1} />;
  if (query.error) return <ErrorState error={query.error} />;
  const { repositories, runs } = query.data;
  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Repositories</h1>
        <p className="text-muted-foreground text-sm">Benchmarks recorded with <code>benchboard ingest</code> or pi's <code>/bench</code>.</p>
      </div>
      {repositories.length === 0 ? (
        <EmptyState title="Nothing recorded yet">
          Run <code>benchboard ingest export.json --benchmark my/bench</code> inside a git checkout, or import pi's history with{" "}
          <code>benchboard import-legacy</code>.
        </EmptyState>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {repositories.map((repository) => {
            const latest = repository.pullRequests[0];
            return (
              <Link key={repository.id} to={`/repositories/${repository.id}`} className="group">
                <Card className="group-hover:border-foreground/30 h-full transition-colors">
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2"><FolderGit2 className="text-muted-foreground size-4" /> {repository.name}</CardTitle>
                    <CardDescription className="truncate font-mono text-xs">{repository.slug}</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <div className="flex gap-6 text-sm">
                      <span><strong className="tabular-nums">{repository.runCount}</strong> <span className="text-muted-foreground">runs</span></span>
                      <span><strong className="tabular-nums">{repository.benchmarks.length}</strong> <span className="text-muted-foreground">benchmarks</span></span>
                      <span><strong className="tabular-nums">{repository.pullRequests.length}</strong> <span className="text-muted-foreground">tracked PRs</span></span>
                    </div>
                    {latest && (
                      <p className="text-muted-foreground truncate text-xs">
                        Latest PR: <span className="text-foreground">{latest.title}</span> · {relativeTime(latest.updatedAt ?? latest.syncedAt)}
                      </p>
                    )}
                  </CardContent>
                </Card>
              </Link>
            );
          })}
        </div>
      )}
      {runs.length > 0 && (
        <Card>
          <CardHeader><CardTitle>Recent runs</CardTitle></CardHeader>
          <CardContent><RunsTable runs={runs} showRepository /></CardContent>
        </Card>
      )}
    </div>
  );
}
