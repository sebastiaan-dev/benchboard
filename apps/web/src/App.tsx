import { lazy, Suspense } from "react";
import { Route, Routes } from "react-router";
import { AppShell } from "@/components/shell";
import { ErrorState, LoadingState, NotFound } from "@/components/bench/states";
import { SignInPage } from "@/pages/sign-in";
import { useSession } from "@/lib/session";

// Pages are split so the charting code only loads where it is used.
const page = <K extends string>(load: () => Promise<Record<K, React.ComponentType>>, name: K) =>
  lazy(() => load().then((module) => ({ default: module[name] })));
const RepositoryOverviewPage = page(() => import("@/pages/repository"), "RepositoryOverviewPage");
const PullRequestsPage = page(() => import("@/pages/repository"), "PullRequestsPage");
const BenchmarksPage = page(() => import("@/pages/repository"), "BenchmarksPage");
const RunsPage = page(() => import("@/pages/repository"), "RunsPage");
const ProfilesPage = page(() => import("@/pages/repository"), "ProfilesPage");
const PullRequestPage = page(() => import("@/pages/pull-request"), "PullRequestPage");
const RunPage = page(() => import("@/pages/run"), "RunPage");
const BenchmarkPage = page(() => import("@/pages/benchmark"), "BenchmarkPage");
const ProfilePage = page(() => import("@/pages/profile"), "ProfilePage");
const ProfileComparePage = page(() => import("@/pages/profile-compare"), "ProfileComparePage");

const HomePage = page(() => import("@/pages/home"), "HomePage");

export function App() {
  const session = useSession();
  if (session.isPending) return null;
  if (session.error) return <div className="p-6"><ErrorState error={session.error} /></div>;
  const { auth, principal, publicRead } = session.data;
  // Servers that need a token show nothing until signed in (unless they allow anonymous reading).
  if (auth === "token" && !principal && !publicRead) return <SignInPage />;
  return (
    <Routes>
      <Route path="/sign-in" element={<SignInPage redirect />} />
      <Route path="*" element={<Pages />} />
    </Routes>
  );
}

function Pages() {
  return (
    <AppShell>
      <Suspense fallback={<LoadingState rows={1} />}>
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/repositories/:id" element={<RepositoryOverviewPage />} />
          <Route path="/repositories/:id/pulls" element={<PullRequestsPage />} />
          <Route path="/repositories/:id/benchmarks" element={<BenchmarksPage />} />
          <Route path="/repositories/:id/runs" element={<RunsPage />} />
          <Route path="/repositories/:id/profiles" element={<ProfilesPage />} />
          <Route path="/pr/:id" element={<PullRequestPage />} />
          <Route path="/runs/:id" element={<RunPage />} />
          <Route path="/benchmarks/:id" element={<BenchmarkPage />} />
          <Route path="/profiles/compare" element={<ProfileComparePage />} />
          <Route path="/profiles/:id" element={<ProfilePage />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </Suspense>
    </AppShell>
  );
}
