import type { Profile, PullRequestReport, ReportPoint, SeriesReport } from "@benchboard/core";
import type { FunctionDelta, Metric } from "@benchboard/core";

/** Parent objects passed between resolvers (carry the context child resolvers need). */
export interface ReportParent extends PullRequestReport {
	repositoryId: number;
}
export interface SeriesParent extends SeriesReport {
	repositoryId: number;
	pullRequestId: number;
}
export interface PointParent extends ReportPoint {
	repositoryId: number;
}
export interface CaseParent {
	repositoryId: number;
	benchmarkId: number;
	caseKey: string;
	count: number;
	lastRecordedAt: string;
}
export interface ProfileDiffParent {
	base: Profile;
	head: Profile;
	metric: Metric;
	baseMs: number;
	headMs: number;
	functions: (FunctionDelta & { deltaSelfMs: number; deltaTotalMs: number })[];
}
