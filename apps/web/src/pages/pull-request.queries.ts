import { graphql } from "@/gql";

export const ComparisonFields = graphql(`
  fragment ComparisonFields on Comparison {
    ratio
    low
    high
    changePercent
    verdict
    sameRun
    pairing
    alternatives
    resamples
    candidate { ...PointMeasurementFields commitSha }
    baseline { ...PointMeasurementFields commitSha }
  }
`);

export const PointMeasurementFields = graphql(`
  fragment PointMeasurementFields on Measurement {
    id
    label
    status
    dirty
    commitInferred
    n
    mean
    median
    stddev
    min
    max
    q1
    q3
    p95
    cv
    recordedAt
    run { id title }
    profiles { id cpuMs label }
  }
`);

export const PullRequestReportQuery = graphql(`
  query PullRequestReport($id: ID!, $statistic: Statistic!, $includeDirty: Boolean!, $machine: ID, $threshold: Float!) {
    pullRequest(id: $id) {
      id
      source
      githubRepo
      number
      title
      url
      state
      author
      headRef
      headSha
      baseRef
      baseSha
      updatedAt
      syncedAt
      repository { id slug name githubRepo }
      report(statistic: $statistic, includeDirty: $includeDirty, machine: $machine, threshold: $threshold) {
        statistic
        threshold
        includeDirty
        machine { id hostname cpu os arch }
        machines { count machine { id hostname cpu } }
        commits { position isBase commit { sha shortSha subject author authoredAt url } }
        summary { series regressions improvements unchanged inconclusive failed insufficient missingReference missingHead crossRun }
        series {
          id
          caseKey
          label
          verdict
          referenceIsBase
          benchmark { id key title }
          headComparison { ...ComparisonFields }
          latestComparison { ...ComparisonFields }
          reference { position }
          head { position }
          latest { position }
          points {
            position
            isBase
            measurement { ...PointMeasurementFields }
            candidates { id }
            vsReference { ...ComparisonFields }
            vsPrevious { ...ComparisonFields }
            previousPosition
            spansGap
          }
        }
      }
    }
  }
`);

export const SeriesSamplesQuery = graphql(`
  query SeriesSamples($ids: [ID!]!) {
    measurements(ids: $ids) {
      ...PointMeasurementFields
      command
      exportedCommand
      build
      revision
      notes
      commitSha
      times
      exitCodes
      run { id title recordedAt conditions environment machine { hostname cpu } }
    }
  }
`);

export const SyncPullRequestMutation = graphql(`
  mutation SyncPullRequest($id: ID!) {
    syncPullRequest(id: $id) { id syncedAt headSha }
  }
`);
