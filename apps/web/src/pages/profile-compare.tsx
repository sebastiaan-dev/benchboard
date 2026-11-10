import { useSearchParams } from "react-router";
import { graphql } from "@/gql";
import { ProfileDiffView } from "@/components/bench/profile-diff";
import { NotFound } from "@/components/bench/states";
import { Crumbs, useRepositoryScope } from "@/components/shell";
import { useGraphQL } from "@/lib/graphql";
import { seriesName } from "@/lib/format";

const CompareContextQuery = graphql(`
  query ProfileCompareContext($head: ID!) {
    profile(id: $head) { id measurement { caseKey benchmark { key repository { id name } } } }
  }
`);

/** Differential profile: which functions gained or lost CPU time between two profiles of a case. */
export function ProfileComparePage() {
  const [params] = useSearchParams();
  const base = params.get("base") ?? "";
  const head = params.get("head") ?? "";
  const context = useGraphQL(CompareContextQuery, { head }, { enabled: Boolean(head) });
  const m = context.data?.profile?.measurement;
  useRepositoryScope(m?.benchmark.repository.id);
  if (!base || !head) return <NotFound what="comparison" />;
  return (
    <div className="space-y-5">
      {m && <Crumbs items={[
        { label: m.benchmark.repository.name, to: `/repositories/${m.benchmark.repository.id}` },
        { label: "Profiles", to: `/repositories/${m.benchmark.repository.id}/profiles` },
        { label: `Compare · ${seriesName(m.benchmark.key, m.caseKey)}` },
      ]} />}
      <ProfileDiffView baseId={base} headId={head} />
    </div>
  );
}
