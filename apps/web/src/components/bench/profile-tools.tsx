import { useMemo, useState } from "react";
import { mergeThreads, type CallTree } from "@benchboard/core/profile-tree";
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
            <SelectItem key={thread.name} value={thread.name}>{thread.name} · {((thread.samples / tree.samples) * 100).toFixed(1)}%</SelectItem>
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
