import { Link, Route, Routes, useLocation } from "react-router";
import { Activity, Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { Button } from "@/components/ui/button";
import { lazy, Suspense } from "react";
import { LoadingState, NotFound } from "@/components/bench/states";

// Pages are split so the charting code only loads where it is used.
const HomePage = lazy(() => import("@/pages/home").then((m) => ({ default: m.HomePage })));
const RepositoryPage = lazy(() => import("@/pages/repository").then((m) => ({ default: m.RepositoryPage })));
const PullRequestPage = lazy(() => import("@/pages/pull-request").then((m) => ({ default: m.PullRequestPage })));
const RunPage = lazy(() => import("@/pages/run").then((m) => ({ default: m.RunPage })));
const BenchmarkPage = lazy(() => import("@/pages/benchmark").then((m) => ({ default: m.BenchmarkPage })));

function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const dark = resolvedTheme === "dark";
  return (
    <Button variant="ghost" size="icon" aria-label="Toggle theme" onClick={() => setTheme(dark ? "light" : "dark")}>
      {dark ? <Sun /> : <Moon />}
    </Button>
  );
}

export function App() {
  const location = useLocation();
  return (
    <div className="min-h-svh bg-background text-foreground">
      <header className="sticky top-0 z-30 border-b bg-background/80 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-[1440px] items-center gap-4 px-6">
          <Link to="/" className="flex items-center gap-2 font-semibold tracking-tight">
            <span className="flex size-7 items-center justify-center rounded-md bg-foreground text-background">
              <Activity className="size-4" />
            </span>
            Benchboard
          </Link>
          <span className="text-muted-foreground hidden text-sm md:inline">Performance across commits</span>
          <div className="ml-auto flex items-center gap-1">
            <Button variant="ghost" size="sm" asChild>
              <a href="/graphql" target="_blank" rel="noreferrer">GraphQL</a>
            </Button>
            <ThemeToggle />
          </div>
        </div>
      </header>
      <main key={location.pathname} className="mx-auto max-w-[1440px] px-6 py-8">
        <Suspense fallback={<LoadingState rows={1} />}>
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/repositories/:id" element={<RepositoryPage />} />
          <Route path="/pr/:id" element={<PullRequestPage />} />
          <Route path="/runs/:id" element={<RunPage />} />
          <Route path="/benchmarks/:id" element={<BenchmarkPage />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
        </Suspense>
      </main>
    </div>
  );
}
