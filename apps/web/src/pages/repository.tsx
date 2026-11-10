import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { GitBranch, GitPullRequest, Plus } from "lucide-react";
import { toast } from "sonner";
import { graphql } from "@/gql";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from "@/components/ui/breadcrumb";
import { EmptyState, ErrorState, LoadingState, NotFound } from "@/components/bench/states";
import { RunsTable } from "@/components/bench/runs-table";
import { useGraphQL, useGraphQLMutation } from "@/lib/graphql";
import { relativeTime } from "@/lib/format";

const RepositoryQuery = graphql(`
  query Repository($id: ID!) {
    repository(id: $id) {
      id
      slug
      name
      githubRepo
      localPath
      runCount
      pullRequests { id source githubRepo number title state headRef baseRef syncedAt updatedAt commits { sha } }
      benchmarks { id key title cases { caseKey count lastRecordedAt } }
      runs(limit: 30) { ...RunRow }
    }
  }
`);

const TrackMutation = graphql(`
  mutation TrackPullRequest($repository: ID!, $reference: String!) {
    trackGithubPullRequest(repository: $repository, reference: $reference) { id }
  }
`);

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
      <Input value={reference} onChange={(event) => setReference(event.target.value)} placeholder="#123, owner/name#123 or URL" className="h-8 w-64" />
      <Button size="sm" type="submit" disabled={!reference.trim() || track.isPending}><Plus /> Track PR</Button>
    </form>
  );
}

export function RepositoryPage() {
  const { id = "" } = useParams();
  const query = useGraphQL(RepositoryQuery, { id });
  if (query.isPending) return <LoadingState rows={2} />;
  if (query.error) return <ErrorState error={query.error} />;
  const repository = query.data.repository;
  if (!repository) return <NotFound what="repository" />;
  return (
    <div className="space-y-6">
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem><BreadcrumbLink asChild><Link to="/">Repositories</Link></BreadcrumbLink></BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem><BreadcrumbPage>{repository.slug}</BreadcrumbPage></BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{repository.name}</h1>
        <p className="text-muted-foreground font-mono text-sm">{repository.slug}{repository.localPath ? ` · ${repository.localPath}` : ""}</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Pull requests</CardTitle>
          <CardDescription>Tracked GitHub PRs and local branches; measurements attach by commit.</CardDescription>
          <CardAction>{repository.githubRepo && <TrackPullRequest repository={repository.id} />}</CardAction>
        </CardHeader>
        <CardContent>
          {repository.pullRequests.length === 0 ? (
            <EmptyState title="No tracked pull requests">
              Run <code>benchboard pr track 123</code> or <code>benchboard pr track --branch</code> in a checkout.
            </EmptyState>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Title</TableHead>
                  <TableHead>Branch</TableHead>
                  <TableHead className="text-right">Commits</TableHead>
                  <TableHead>State</TableHead>
                  <TableHead className="text-right">Updated</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {repository.pullRequests.map((pr) => (
                  <TableRow key={pr.id}>
                    <TableCell>
                      <Link to={`/pr/${pr.id}`} className="flex items-center gap-2 font-medium hover:underline">
                        {pr.source === "GITHUB" ? <GitPullRequest className="text-muted-foreground size-4" /> : <GitBranch className="text-muted-foreground size-4" />}
                        {pr.title}
                        {pr.number !== null && <span className="text-muted-foreground font-normal">#{pr.number}</span>}
                      </Link>
                    </TableCell>
                    <TableCell className="text-muted-foreground font-mono text-xs">{pr.baseRef} ← {pr.headRef}</TableCell>
                    <TableCell className="text-right tabular-nums">{pr.commits.length}</TableCell>
                    <TableCell><Badge variant="outline" className="capitalize">{pr.state}</Badge></TableCell>
                    <TableCell className="text-muted-foreground text-right text-xs">{relativeTime(pr.updatedAt ?? pr.syncedAt)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Benchmarks</CardTitle>
          <CardDescription>{repository.benchmarks.length} benchmarks · {repository.runCount} runs</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Key</TableHead>
                <TableHead>Title</TableHead>
                <TableHead>Cases</TableHead>
                <TableHead className="text-right">Measurements</TableHead>
                <TableHead className="text-right">Last recorded</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {repository.benchmarks.map((benchmark) => {
                const last = benchmark.cases.map((entry) => entry.lastRecordedAt).sort().at(-1);
                return (
                  <TableRow key={benchmark.id}>
                    <TableCell><Link to={`/benchmarks/${benchmark.id}`} className="font-mono text-xs font-medium hover:underline">{benchmark.key}</Link></TableCell>
                    <TableCell className="max-w-80 truncate">{benchmark.title}</TableCell>
                    <TableCell className="text-muted-foreground max-w-72 truncate font-mono text-xs">{benchmark.cases.map((entry) => entry.caseKey).join(", ")}</TableCell>
                    <TableCell className="text-right tabular-nums">{benchmark.cases.reduce((sum, entry) => sum + entry.count, 0)}</TableCell>
                    <TableCell className="text-muted-foreground text-right text-xs">{relativeTime(last)}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Recent runs</CardTitle></CardHeader>
        <CardContent><RunsTable runs={repository.runs} /></CardContent>
      </Card>
    </div>
  );
}
