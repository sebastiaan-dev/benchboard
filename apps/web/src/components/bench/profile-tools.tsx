import { useMemo, useState } from "react";
import { mergeThreads, type CallTree, type Metric } from "@benchboard/core/profile-tree";
import { Segmented } from "@/components/kit/encodings";
import { Hint } from "@/components/bench/states";
import { graphql } from "@/gql";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";

export const ProfileHeaderFields = graphql(`
  fragment ProfileHeader on Profile {
    id
    label
    product
    samples
    intervalMs
    iterations
    cpuMs
    sampledMs
    cpuSource
    durationMs
    symbolicatedShare
    hasSymbols
    nodeCount
    command
    recordedAt
    rawPath
    threads { name samples cpuMs sampledMs }
    measurement {
      id
      position
      caseKey
      label
      commitSha
      dirty
      median
      commit { shortSha subject url }
      benchmark { id key title repository { id slug name } }
      run { id title recordedAt machine { hostname cpu } }
    }
  }
`);

export const ProfilePairQuery = graphql(`
  query ProfilePair($base: ID!, $head: ID!) {
    base: profile(id: $base) { ...ProfileHeader tree }
    head: profile(id: $head) { ...ProfileHeader tree }
  }
`);

export function ms(value: number) {
  const size = Math.abs(value);
  return size >= 1000 ? `${(value / 1000).toFixed(2)} s` : `${value.toFixed(size >= 100 ? 0 : size >= 10 ? 1 : 2)} ms`;
}

/** Applies the thread selection: one thread, all threads merged, or the per-thread tree. */
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

export type ThreadState = Pick<ReturnType<typeof useThreadView>, "merge" | "setMerge" | "thread" | "setThread">;

export function ThreadControls({ tree, state }: { tree: CallTree; state: ThreadState }) {
  return (
    <div className="flex flex-wrap items-center gap-4">
      <Select value={state.thread} onValueChange={state.setThread}>
        <SelectTrigger size="sm" className="min-w-44"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All threads ({tree.threads.length})</SelectItem>
          {tree.threads.map((thread) => (
            <SelectItem key={thread.name} value={thread.name}>
              {thread.name} · {tree.cpuMs ? ((thread.cpuMs / tree.cpuMs) * 100).toFixed(1) : "0.0"}% CPU · {tree.sampledMs ? ((thread.sampledMs / tree.sampledMs) * 100).toFixed(1) : "0.0"}% sampled
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {state.thread === "all" && (
        <div className="flex items-center gap-2">
          <Switch id="merge-threads" checked={state.merge} onCheckedChange={state.setMerge} />
          <Label htmlFor="merge-threads" className="text-muted-foreground text-xs">Merge threads</Label>
        </div>
      )}
    </div>
  );
}

/** On-CPU vs sampled time. Sampled time includes waiting, sleeping and blocking (where wall time goes). */
export function MetricToggle({ value, onChange, cpuSource }: { value: Metric; onChange: (metric: Metric) => void; cpuSource: string }) {
  return (
    <Hint content={cpuSource === "SAMPLE_COUNT"
      ? "This profile has no per-sample CPU deltas, so CPU time is estimated from samples and includes off-CPU time."
      : "On-CPU: measured from samply's per-thread CPU deltas. Sampled: samples × interval, which also counts time spent waiting, sleeping or blocked."}>
      <span>
        <Segmented value={value} onChange={onChange} options={[
          { value: "cpu", label: cpuSource === "SAMPLE_COUNT" ? "CPU (estimated)" : "On-CPU" },
          { value: "sampled", label: "Sampled (incl. waiting)" },
        ]} />
      </span>
    </Hint>
  );
}

export const metricLabel = (metric: Metric) => metric === "cpu" ? "on-CPU" : "sampled";
