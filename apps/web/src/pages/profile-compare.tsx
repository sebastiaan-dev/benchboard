import { useNavigate, useSearchParams } from "react-router";
import { ArrowLeftRight, GitCompare } from "lucide-react";
import { graphql } from "@/gql";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ProfileDiffView } from "@/components/bench/profile-diff";
import { EmptyState } from "@/components/bench/states";
import { Crumbs, useCurrentRepository, useRepositoryScope } from "@/components/shell";
import { Panel, PanelHeader } from "@/components/kit/panel";
import { useGraphQL } from "@/lib/graphql";
import { seriesName } from "@/lib/format";

const CompareOptionsQuery = graphql(`
  query ProfileCompareOptions($repository: ID!) {
    repository(id: $repository) {
      id
      name
      profiles(limit: 300) {
        id label cpuMs recordedAt
        measurement { caseKey commitSha dirty commit { subject positions { position } } benchmark { id key } }
      }
    }
  }
`);

const ContextQuery = graphql(`
  query ProfileCompareContext($head: ID!) {
    profile(id: $head) { id measurement { benchmark { repository { id } } } }
  }
`);

/** Base/head pickers (grouped by series) with a swap button; drives the URL. */
function Pickers({ repositoryId, base, head }: { repositoryId: string; base: string; head: string }) {
  const navigate = useNavigate();
  const query = useGraphQL(CompareOptionsQuery, { repository: repositoryId });
  const profiles = query.data?.repository?.profiles ?? [];
  const groups = [...Map.groupBy(profiles, (profile) => `${profile.measurement.benchmark.key}\0${profile.measurement.caseKey}`)];
  const go = (nextBase: string, nextHead: string) => navigate(`/profiles/compare?base=${nextBase}&head=${nextHead}`, { replace: true });
  const label = (profile: (typeof profiles)[number]) => {
    const position = profile.measurement.commit?.positions[0]?.position;
    return `${position === undefined || position < 0 ? "" : position === 0 ? "base · " : `#${position} · `}${profile.measurement.commitSha?.slice(0, 7) ?? "?"}${profile.measurement.dirty ? "*" : ""} · ${profile.cpuMs.toFixed(1)} ms`;
  };
  const picker = (value: string, onChange: (id: string) => void, placeholder: string) => (
    <Select value={value || undefined} onValueChange={onChange}>
      <SelectTrigger size="sm" className="w-72"><SelectValue placeholder={placeholder} /></SelectTrigger>
      <SelectContent>
        {groups.map(([key, list]) => (
          <SelectGroup key={key}>
            <SelectLabel>{seriesName(list[0].measurement.benchmark.key, list[0].measurement.caseKey)}</SelectLabel>
            {list.map((profile) => (
              <SelectItem key={profile.id} value={profile.id}>
                {label(profile)} <span className="text-muted-foreground truncate">{profile.measurement.commit?.subject}</span>
              </SelectItem>
            ))}
          </SelectGroup>
        ))}
      </SelectContent>
    </Select>
  );
  return (
    <div className="flex flex-wrap items-center gap-2">
      {picker(base, (id) => go(id, head), "Base profile…")}
      <Button variant="outline" size="icon" className="size-8" aria-label="Swap base and head" disabled={!base || !head} onClick={() => go(head, base)}>
        <ArrowLeftRight />
      </Button>
      {picker(head, (id) => go(base, id), "Head profile…")}
    </div>
  );
}

/** Differential profile: which functions gained or lost time between two profiles of a case. */
export function ProfileComparePage() {
  const [params] = useSearchParams();
  const base = params.get("base") ?? "";
  const head = params.get("head") ?? "";
  const context = useGraphQL(ContextQuery, { head }, { enabled: Boolean(head) });
  const current = useCurrentRepository();
  const repositoryId = context.data?.profile?.measurement.benchmark.repository.id ?? current;
  useRepositoryScope(context.data?.profile?.measurement.benchmark.repository.id);
  return (
    <div className="space-y-5">
      <Crumbs items={[
        ...(repositoryId ? [{ label: "Profiles", to: `/repositories/${repositoryId}/profiles` }] : []),
        { label: "Compare profiles" },
      ]} />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold tracking-tight">Compare profiles</h1>
        {repositoryId && <Pickers repositoryId={repositoryId} base={base} head={head} />}
      </div>
      {base && head ? <ProfileDiffView key={`${base}:${head}`} baseId={base} headId={head} /> : (
        <Panel>
          <PanelHeader icon={GitCompare} title="Choose two profiles" subtitle="Pick a base and a head above; profiles of the same series are grouped together" />
          <div className="px-4 pb-4"><EmptyState title="No profiles selected" /></div>
        </Panel>
      )}
    </div>
  );
}
