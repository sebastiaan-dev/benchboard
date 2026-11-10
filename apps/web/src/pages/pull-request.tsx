import { useMemo } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { ExternalLink, GitBranch, GitPullRequest, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from "@/components/ui/breadcrumb";
import { CommitMatrix, type MatrixColumn, type MatrixRow } from "@/components/bench/commit-matrix";
import { ImpactChart, type ImpactDatum } from "@/components/bench/impact-chart";
import { TimelineChart } from "@/components/bench/timeline-chart";
import { SeriesSheet } from "@/components/bench/series-sheet";
import { EmptyState, ErrorState, Hint, LoadingState, NotFound } from "@/components/bench/states";
import { useGraphQL, useGraphQLMutation } from "@/lib/graphql";
import { relativeTime, seriesName } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { PullRequestReportQuery as ReportResult, Statistic } from "@/gql/graphql";
import { PullRequestReportQuery, SyncPullRequestMutation } from "./pull-request.queries";

export type Report = NonNullable<ReportResult["pullRequest"]>["report"];
export type Series = Report["series"][number];

function SummaryCard({ label, value, tone, hint }: { label: string; value: number; tone: string; hint: string }) {
  return (
    <Card className="gap-1 py-4">
      <CardContent className="px-4">
        <Hint content={hint}>
          <div className="text-muted-foreground w-fit cursor-default text-xs font-medium uppercase tracking-wide">{label}</div>
        </Hint>
        <div className={cn("mt-1 text-3xl font-semibold tabular-nums", value > 0 && tone)}>{value}</div>
      </CardContent>
    </Card>
  );
}

export function PullRequestPage() {
  const { id = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const statistic = (params.get("statistic") === "MEAN" ? "MEAN" : "MEDIAN") satisfies Statistic;
  const includeDirty = params.get("dirty") === "1";
  const threshold = Number(params.get("threshold") ?? 2) / 100;
  const machine = params.get("machine");
  const selectedSeries = params.get("series");
  const update = (changes: Record<string, string | null>) => setParams((current) => {
    const next = new URLSearchParams(current);
    for (const [key, value] of Object.entries(changes)) value === null ? next.delete(key) : next.set(key, value);
    return next;
  }, { replace: true });

  const query = useGraphQL(PullRequestReportQuery, { id, statistic, includeDirty, machine, threshold }, { placeholderData: (previous) => previous });
  const sync = useGraphQLMutation(SyncPullRequestMutation);
  const pr = query.data?.pullRequest;
  const report = pr?.report;

  const derived = useMemo(() => {
    if (!report) return null;
    const columns: MatrixColumn[] = report.commits.map((entry) => ({
      position: entry.position, label: entry.commit.shortSha.slice(0, 7), subject: entry.commit.subject ?? "",
      author: entry.commit.author, isBase: entry.isBase,
    }));
    const name = (series: Series) => seriesName(series.benchmark.key, series.caseKey);
    const rows: MatrixRow[] = report.series.map((series) => ({
      id: series.id,
      name: name(series),
      detail: series.benchmark.title ?? series.label,
      cells: series.points.map((point) => ({
        value: point.measurement ? (statistic === "MEAN" ? point.measurement.mean : point.measurement.median) : null,
        dirty: point.measurement?.dirty ?? false,
        isReference: series.reference?.position === point.position,
        vsReference: point.vsReference,
        vsPrevious: point.vsPrevious,
        extra: Math.max(0, point.candidates.length - 1),
        profiled: (point.measurement?.profiles.length ?? 0) > 0,
      })),
    }));
    const impact: ImpactDatum[] = report.series.flatMap((series) => series.latestComparison ? [{
      id: series.id, name: name(series), ratio: series.latestComparison.ratio, low: series.latestComparison.low,
      high: series.latestComparison.high, verdict: series.latestComparison.verdict, sameRun: series.latestComparison.sameRun,
    }] : []);
    const timeline = report.series.map((series) => ({
      id: series.id, name: name(series),
      ratios: series.points.map((point) => point.vsReference?.ratio ?? (series.reference?.position === point.position ? 1 : null)),
    }));
    return { columns, rows, impact, timeline };
  }, [report, statistic]);

  if (query.isPending) return <LoadingState />;
  if (query.error && !pr) return <ErrorState error={query.error} />;
  if (!pr || !report || !derived) return <NotFound what="pull request" />;

  const s = report.summary;
  const selected = report.series.find((series) => series.id === selectedSeries) ?? null;
  const prCommits = report.commits.filter((entry) => !entry.isBase).length;

  return (
    <div className="space-y-6">
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem><BreadcrumbLink asChild><Link to="/">Repositories</Link></BreadcrumbLink></BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem><BreadcrumbLink asChild><Link to={`/repositories/${pr.repository.id}`}>{pr.repository.slug}</Link></BreadcrumbLink></BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem><BreadcrumbPage>{pr.source === "GITHUB" ? `#${pr.number}` : pr.headRef}</BreadcrumbPage></BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 space-y-2">
          <div className="flex items-center gap-3">
            {pr.source === "GITHUB" ? <GitPullRequest className="text-muted-foreground size-6" /> : <GitBranch className="text-muted-foreground size-6" />}
            <h1 className="truncate text-2xl font-semibold tracking-tight">{pr.title}</h1>
            {pr.number !== null && <span className="text-muted-foreground text-2xl font-light">#{pr.number}</span>}
            <Badge variant="outline" className="capitalize">{pr.state}</Badge>
          </div>
          <p className="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
            <span className="font-mono text-foreground">{pr.baseRef}</span>
            <span className="font-mono text-xs">@{pr.baseSha?.slice(0, 7) ?? "?"}</span>
            <span>←</span>
            <span className="font-mono text-foreground">{pr.headRef}</span>
            <span className="font-mono text-xs">@{pr.headSha.slice(0, 7)}</span>
            <span>· {prCommits} commit{prCommits === 1 ? "" : "s"}</span>
            {pr.author && <span>· {pr.author}</span>}
            <span>· synced {relativeTime(pr.syncedAt)}</span>
          </p>
        </div>
        <div className="flex gap-2">
          {pr.url && (
            <Button variant="outline" size="sm" asChild>
              <a href={pr.url} target="_blank" rel="noreferrer"><ExternalLink /> GitHub</a>
            </Button>
          )}
          <Button variant="outline" size="sm" disabled={sync.isPending}
            onClick={() => sync.mutate({ id: pr.id }, {
              onSuccess: () => toast.success("Pull request synced"),
              onError: (error) => toast.error(error.message),
            })}>
            <RefreshCw className={cn(sync.isPending && "animate-spin")} /> Sync commits
          </Button>
        </div>
      </div>

      <Card className="py-3">
        <CardContent className="flex flex-wrap items-center gap-x-6 gap-y-3 px-4">
          <div className="flex items-center gap-2">
            <Label className="text-muted-foreground text-xs">Statistic</Label>
            <ToggleGroup type="single" size="sm" variant="outline" value={statistic}
              onValueChange={(value) => value && update({ statistic: value === "MEAN" ? "MEAN" : null })}>
              <ToggleGroupItem value="MEDIAN">Median</ToggleGroupItem>
              <ToggleGroupItem value="MEAN">Mean</ToggleGroupItem>
            </ToggleGroup>
          </div>
          <div className="flex items-center gap-2">
            <Label className="text-muted-foreground text-xs">Threshold</Label>
            <Select value={String(threshold * 100)} onValueChange={(value) => update({ threshold: value === "2" ? null : value })}>
              <SelectTrigger size="sm" className="w-20"><SelectValue /></SelectTrigger>
              <SelectContent>
                {["0.5", "1", "2", "3", "5", "10"].map((value) => <SelectItem key={value} value={value}>±{value}%</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center gap-2">
            <Label className="text-muted-foreground text-xs">Machine</Label>
            <Select value={report.machine?.id ?? ""} onValueChange={(value) => update({ machine: value })} disabled={report.machines.length < 2}>
              <SelectTrigger size="sm" className="min-w-48"><SelectValue placeholder="No measurements" /></SelectTrigger>
              <SelectContent>
                {report.machines.map((entry) => (
                  <SelectItem key={entry.machine.id} value={entry.machine.id}>
                    {entry.machine.hostname} · {entry.machine.cpu} <span className="text-muted-foreground">({entry.count})</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center gap-2">
            <Switch id="dirty" checked={includeDirty} onCheckedChange={(checked) => update({ dirty: checked ? "1" : null })} />
            <Label htmlFor="dirty" className="text-muted-foreground text-xs">Include dirty builds</Label>
          </div>
          {query.isFetching && <RefreshCw className="text-muted-foreground size-4 animate-spin" />}
        </CardContent>
      </Card>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <SummaryCard label="Regressions" value={s.regressions} tone="text-red-600 dark:text-red-400"
          hint="95% CI of head / reference lies above 1 and the change exceeds the threshold." />
        <SummaryCard label="Improvements" value={s.improvements} tone="text-emerald-600 dark:text-emerald-400"
          hint="95% CI lies below 1 and the change exceeds the threshold." />
        <SummaryCard label="Unchanged" value={s.unchanged} tone=""
          hint="Change within the threshold with a CI inside twice the threshold." />
        <SummaryCard label="Inconclusive" value={s.inconclusive} tone="text-amber-600 dark:text-amber-400"
          hint="The interval is too wide to decide; collect more samples or measure base and head in one run." />
        <SummaryCard label="Series" value={s.series} tone=""
          hint="Benchmark cases measured on at least one commit of this PR on the selected machine." />
      </div>
      {(s.missingReference > 0 || s.crossRun > 0 || s.failed > 0) && (
        <div className="text-muted-foreground flex flex-wrap gap-x-6 gap-y-1 text-sm">
          {s.missingReference > 0 && <span>⚠ {s.missingReference} series have no measurement at the base; they are compared to their first measured commit.</span>}
          {s.crossRun > 0 && <span>⚠ {s.crossRun} head comparisons use different Hyperfine runs and may include session drift.</span>}
          {s.failed > 0 && <span>⚠ {s.failed} comparisons involve failed commands.</span>}
        </div>
      )}

      {report.series.length === 0 ? (
        <EmptyState title="No measurements on this pull request yet">
          Ingest Hyperfine exports with <code>--commit</code> set to the base or PR commits, e.g.{" "}
          <code>benchboard ingest bench.json --benchmark tpch/sf1 --commit HEAD</code>.
        </EmptyState>
      ) : <>
        <div className="grid gap-6 xl:grid-cols-5">
          <Card className="xl:col-span-2">
            <CardHeader>
              <CardTitle>Head vs {s.missingReference === s.series ? "first measurement" : "base"}</CardTitle>
              <CardDescription>{statistic === "MEAN" ? "Mean" : "Median"} change with 95% bootstrap interval</CardDescription>
            </CardHeader>
            <CardContent>
              {derived.impact.length ? <ImpactChart data={derived.impact} onSelect={(series) => update({ series })} />
                : <EmptyState title="Needs at least two measured commits per series" />}
            </CardContent>
          </Card>
          <Card className="xl:col-span-3">
            <CardHeader>
              <CardTitle>Across commits</CardTitle>
              <CardDescription>Change vs each series' reference; click a legend entry to focus</CardDescription>
            </CardHeader>
            <CardContent>
              <TimelineChart
                commits={derived.columns.map((column) => ({ position: column.position, label: column.isBase ? "base" : column.label, subject: column.subject }))}
                series={derived.timeline}
              />
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Commit matrix</CardTitle>
            <CardDescription>
              Each cell compares a commit with the series reference (outlined). Arrows mark confident step changes from the previous measured commit; dashed cells are dirty builds; flames mark CPU profiles.
            </CardDescription>
            <CardAction className="text-muted-foreground text-xs">Click a row for samples and provenance</CardAction>
          </CardHeader>
          <CardContent>
            <CommitMatrix columns={derived.columns} rows={derived.rows} onSelect={(series) => update({ series })} />
          </CardContent>
        </Card>
      </>}

      <SeriesSheet
        series={selected}
        report={report}
        statistic={statistic}
        onClose={() => update({ series: null })}
      />
    </div>
  );
}
