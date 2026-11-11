import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Link, useLocation, useNavigate } from "react-router";
import {
  Activity, ChevronsUpDown, Flame, FolderGit2, GitBranch, GitPullRequest, Layers, LayoutDashboard, ListChecks, Moon, Search, Sun, Workflow,
} from "lucide-react";
import { useTheme } from "next-themes";
import { graphql } from "@/gql";
import {
  Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupLabel, SidebarHeader, SidebarInset, SidebarMenu,
  SidebarMenuBadge, SidebarMenuButton, SidebarMenuItem, SidebarProvider, SidebarTrigger,
} from "@/components/ui/sidebar";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Command, CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Kbd } from "@/components/ui/kbd";
import { Separator } from "@/components/ui/separator";
import { StatusDot, verdictVar } from "@/components/kit/encodings";
import { useGraphQL } from "@/lib/graphql";
import { relativeTime, seriesName } from "@/lib/format";

const ShellQuery = graphql(`
  query Shell {
    repositories {
      id
      name
      slug
      runCount
      benchmarks { id }
      profileCount
      pullRequests {
        id
        title
        number
        source
        state
        headRef
        updatedAt
        syncedAt
        report { summary { series regressions improvements inconclusive } }
      }
    }
  }
`);

const PaletteQuery = graphql(`
  query Palette($repository: ID!, $search: String) {
    repository(id: $repository) {
      id
      benchmarks { id key title cases { caseKey count } }
      runs(limit: 25, search: $search) { id title recordedAt machine { hostname } measurements { commitSha benchmark { key } } }
      runCount(search: $search)
      profiles(limit: 25, search: $search) { id label measurement { caseKey commitSha benchmark { key } } }
    }
  }
`);

interface ShellContextValue {
  repositoryId: string | null;
  setRepositoryId: (id: string) => void;
  slot: HTMLElement | null;
}

const ShellContext = createContext<ShellContextValue>({ repositoryId: null, setRepositoryId: () => {}, slot: null });

/** Pages announce which repository they belong to so the sidebar follows them. */
export function useRepositoryScope(id: string | null | undefined) {
  const { repositoryId, setRepositoryId } = useContext(ShellContext);
  useEffect(() => {
    if (id && id !== repositoryId) setRepositoryId(id);
  }, [id, repositoryId, setRepositoryId]);
  return repositoryId;
}

export function useCurrentRepository() {
  return useContext(ShellContext).repositoryId;
}

/** Renders breadcrumbs (or any content) into the top bar. */
export function TopBar({ children }: { children: ReactNode }) {
  const { slot } = useContext(ShellContext);
  return slot ? createPortal(children, slot) : null;
}

export function Crumbs({ items }: { items: { label: ReactNode; to?: string }[] }) {
  return (
    <TopBar>
      <nav className="flex min-w-0 items-center gap-1.5 text-sm">
        {items.map((item, index) => (
          <span key={index} className="flex min-w-0 items-center gap-1.5">
            {index > 0 && <span className="text-muted-foreground/50">/</span>}
            {item.to ? <Link to={item.to} className="text-muted-foreground hover:text-foreground truncate">{item.label}</Link>
              : <span className="truncate font-medium">{item.label}</span>}
          </span>
        ))}
      </nav>
    </TopBar>
  );
}

function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const dark = resolvedTheme === "dark";
  return (
    <SidebarMenuButton onClick={() => setTheme(dark ? "light" : "dark")} tooltip="Toggle theme">
      {dark ? <Sun /> : <Moon />} <span>{dark ? "Light mode" : "Dark mode"}</span>
    </SidebarMenuButton>
  );
}

function Palette({ open, onOpenChange, repositoryId }: { open: boolean; onOpenChange: (open: boolean) => void; repositoryId: string | null }) {
  const navigate = useNavigate();
  const [text, setText] = useState("");
  const [search, setSearch] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setSearch(text.trim()), 200);
    return () => clearTimeout(timer);
  }, [text]);
  const shell = useGraphQL(ShellQuery, {});
  // Runs and profiles are searched on the server, so older history is reachable too.
  const palette = useGraphQL(PaletteQuery, { repository: repositoryId ?? "", search: search || null },
    { enabled: open && Boolean(repositoryId), placeholderData: (previous) => previous });
  // Server results already match; prefixing the query keeps cmdk's own filter from hiding them.
  const serverValue = (value: string) => `${text} ${value}`;
  const repository = shell.data?.repositories.find((entry) => entry.id === repositoryId);
  const go = (to: string) => { onOpenChange(false); navigate(to); };
  return (
    <CommandDialog open={open} onOpenChange={onOpenChange} title="Jump to" description="Pull requests, benchmarks, runs and profiles" className="sm:max-w-xl">
      <Command>
      <CommandInput value={text} onValueChange={setText} placeholder="Jump to a pull request, benchmark, run (title, ID, SHA) or profile…" />
      <CommandList>
        <CommandEmpty>No matches.</CommandEmpty>
        {repository && (
          <CommandGroup heading="Pages">
            {[["Overview", ""], ["Pull requests", "/pulls"], ["Benchmarks", "/benchmarks"], ["Runs", "/runs"], ["Profiles", "/profiles"]].map(([label, path]) => (
              <CommandItem key={label} onSelect={() => go(`/repositories/${repository.id}${path}`)}>{label}</CommandItem>
            ))}
          </CommandGroup>
        )}
        {shell.data?.repositories.some((repo) => repo.pullRequests.length) && <CommandGroup heading="Pull requests">
          {shell.data?.repositories.flatMap((repo) => repo.pullRequests.map((pr) => (
            <CommandItem key={pr.id} value={`pr ${pr.title} ${pr.number ?? pr.headRef} ${repo.name}`} onSelect={() => go(`/pr/${pr.id}`)}>
              {pr.source === "GITHUB" ? <GitPullRequest /> : <GitBranch />}
              <span className="truncate">{pr.title}</span>
              <span className="text-muted-foreground ml-auto shrink-0 font-mono text-xs">{pr.number ? `#${pr.number}` : pr.headRef}</span>
            </CommandItem>
          )))}
        </CommandGroup>}
        {palette.data?.repository && <>
          <CommandGroup heading="Series">
            {palette.data.repository.benchmarks.flatMap((benchmark) => benchmark.cases.map((entry) => (
              <CommandItem key={`${benchmark.id}:${entry.caseKey}`} value={`series ${benchmark.key} ${entry.caseKey} ${benchmark.title ?? ""}`}
                onSelect={() => go(`/benchmarks/${benchmark.id}?case=${encodeURIComponent(entry.caseKey)}`)}>
                <Layers />
                <span className="truncate"><span className="text-muted-foreground font-mono text-xs">{benchmark.key} · </span>{entry.caseKey === "default" ? benchmark.title ?? benchmark.key : entry.caseKey}</span>
                <span className="text-muted-foreground ml-auto shrink-0 font-mono text-xs">{entry.count} runs</span>
              </CommandItem>
            )))}
          </CommandGroup>
          <CommandGroup heading={search ? "Profiles · matching" : "Recent profiles"}>
            {palette.data.repository.profiles.map((profile) => (
              <CommandItem key={profile.id} value={serverValue(`profile ${profile.id} ${profile.measurement.benchmark.key} ${profile.measurement.caseKey} ${profile.label ?? ""}`)}
                onSelect={() => go(`/profiles/${profile.id}`)}>
                <Flame /> <span className="truncate">{seriesName(profile.measurement.benchmark.key, profile.measurement.caseKey)}</span>
                <span className="text-muted-foreground ml-auto shrink-0 font-mono text-xs">{profile.measurement.commitSha?.slice(0, 7)}</span>
              </CommandItem>
            ))}
          </CommandGroup>
          <CommandGroup heading={search ? `Runs · ${palette.data.repository.runCount} matching${palette.data.repository.runCount > 25 ? " (first 25)" : ""}` : "Recent runs"}>
            {palette.data.repository.runs.map((run) => {
              const shas = [...new Set(run.measurements.map((m) => m.commitSha?.slice(0, 7)).filter(Boolean))];
              return (
                <CommandItem key={run.id} value={serverValue(`run ${run.title ?? ""} ${run.id} ${run.measurements.map((m) => `${m.commitSha ?? ""} ${m.benchmark.key}`).join(" ")}`)} onSelect={() => go(`/runs/${run.id}`)}>
                  <ListChecks />
                  <span className="grid min-w-0">
                    <span className="truncate">{run.title ?? run.id}</span>
                    <span className="text-muted-foreground truncate font-mono text-[11px]">
                      {run.measurements[0]?.benchmark.key} · {shas.slice(0, 2).join(", ")}{shas.length > 2 ? ` +${shas.length - 2}` : ""} · {run.machine.hostname}
                    </span>
                  </span>
                  <span className="text-muted-foreground ml-auto shrink-0 text-xs">{relativeTime(run.recordedAt)}</span>
                </CommandItem>
              );
            })}
          </CommandGroup>
        </>}
      </CommandList>
      </Command>
    </CommandDialog>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const [repositoryId, setRepositoryIdState] = useState<string | null>(() => localStorage.getItem("benchboard.repository"));
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();
  const shell = useGraphQL(ShellQuery, {}, { staleTime: 30_000 });
  const repositories = shell.data?.repositories ?? [];
  const repository = repositories.find((entry) => entry.id === repositoryId) ?? repositories[0];
  const setRepositoryId = (id: string) => {
    localStorage.setItem("benchboard.repository", id);
    setRepositoryIdState(id);
  };
  const context = useMemo(() => ({ repositoryId: repository?.id ?? null, setRepositoryId, slot }), [repository?.id, slot]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Without a repository the sections have nothing to show; they are listed but disabled.
  const base = repository ? `/repositories/${repository.id}` : null;
  const nav: { label: string; icon: typeof Flame; to: string; exact?: boolean; count?: number }[] = !base ? [{ label: "Overview", icon: LayoutDashboard, to: "/", exact: true }] : [
    { label: "Overview", icon: LayoutDashboard, to: base, exact: true },
    { label: "Pull requests", icon: GitPullRequest, to: `${base}/pulls`, count: repository?.pullRequests.length },
    { label: "Benchmarks", icon: Layers, to: `${base}/benchmarks`, count: repository?.benchmarks.length },
    { label: "Runs", icon: ListChecks, to: `${base}/runs`, count: repository?.runCount },
    { label: "Profiles", icon: Flame, to: `${base}/profiles`, count: repository?.profileCount },
  ];
  const active = (to: string, exact?: boolean) => exact ? location.pathname === to : location.pathname.startsWith(to);

  return (
    <ShellContext value={context}>
      <SidebarProvider>
        <Sidebar variant="inset" collapsible="icon">
          <SidebarHeader>
            <SidebarMenu>
              <SidebarMenuItem>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <SidebarMenuButton size="lg" className="data-[state=open]:bg-sidebar-accent">
                      <span className="bg-foreground text-background flex aspect-square size-8 items-center justify-center rounded-lg">
                        <Activity className="size-4" />
                      </span>
                      <span className="grid min-w-0 flex-1 text-left leading-tight">
                        <span className="truncate text-sm font-semibold">{repository?.name ?? "Benchboard"}</span>
                        <span className="text-muted-foreground truncate font-mono text-[11px]">{repository?.slug ?? "no repositories yet"}</span>
                      </span>
                      <ChevronsUpDown className="text-muted-foreground ml-auto size-4" />
                    </SidebarMenuButton>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="w-72">
                    <DropdownMenuLabel className="text-muted-foreground text-xs">Repositories</DropdownMenuLabel>
                    {repositories.map((entry) => (
                      <DropdownMenuItem key={entry.id} onSelect={() => { setRepositoryId(entry.id); navigate(`/repositories/${entry.id}`); }}>
                        <FolderGit2 className="size-4" />
                        <span className="grid min-w-0">
                          <span className="truncate">{entry.name}</span>
                          <span className="text-muted-foreground truncate font-mono text-[11px]">{entry.slug}</span>
                        </span>
                        <span className="text-muted-foreground ml-auto font-mono text-xs">{entry.runCount}</span>
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarHeader>
          <SidebarContent>
            <SidebarGroup>
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton onClick={() => setPaletteOpen(true)} tooltip="Jump to… (⌘K)" className="text-muted-foreground">
                    <Search /> <span>Jump to…</span> <Kbd className="ml-auto">⌘K</Kbd>
                  </SidebarMenuButton>
                </SidebarMenuItem>
                {nav.map((item) => (
                  <SidebarMenuItem key={item.label}>
                    <SidebarMenuButton asChild isActive={active(item.to, item.exact)} tooltip={item.label}>
                      <Link to={item.to}><item.icon /> <span>{item.label}</span></Link>
                    </SidebarMenuButton>
                    {item.count !== undefined && item.count > 0 && <SidebarMenuBadge className="font-mono text-[11px]">{item.count}</SidebarMenuBadge>}
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroup>
            {repository && repository.pullRequests.length > 0 && (
              <SidebarGroup>
                <SidebarGroupLabel className="font-mono text-[10.5px] tracking-[0.08em] uppercase">Tracked pull requests</SidebarGroupLabel>
                <SidebarMenu>
                  {repository.pullRequests.slice(0, 12).map((pr) => {
                    const s = pr.report.summary;
                    const color = s.regressions ? verdictVar.REGRESSION : s.inconclusive ? verdictVar.INCONCLUSIVE : s.improvements ? verdictVar.IMPROVEMENT : verdictVar.NONE;
                    return (
                      <SidebarMenuItem key={pr.id}>
                        <SidebarMenuButton asChild isActive={location.pathname === `/pr/${pr.id}`} tooltip={pr.title} className="h-auto py-1.5">
                          <Link to={`/pr/${pr.id}`}>
                            {pr.source === "GITHUB" ? <GitPullRequest /> : <GitBranch />}
                            <span className="grid min-w-0 flex-1">
                              <span className="truncate text-[13px]">{pr.title}</span>
                              <span className="text-muted-foreground flex items-center gap-1.5 font-mono text-[10.5px]">
                                <StatusDot color={color} className="size-1.5" />
                                {s.series ? <>
                                  {s.regressions > 0 && <span className="text-bad">▲{s.regressions}</span>}
                                  {s.improvements > 0 && <span className="text-good">▼{s.improvements}</span>}
                                  <span>{s.series} series</span>
                                </> : <span>not measured</span>}
                              </span>
                            </span>
                          </Link>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    );
                  })}
                </SidebarMenu>
              </SidebarGroup>
            )}
          </SidebarContent>
          <SidebarFooter>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton asChild tooltip="GraphQL explorer">
                  <a href="/graphql" target="_blank" rel="noreferrer"><Workflow /> <span>GraphQL</span></a>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem><ThemeToggle /></SidebarMenuItem>
            </SidebarMenu>
          </SidebarFooter>
        </Sidebar>
        <SidebarInset className="min-w-0">
          <header className="bg-card/80 sticky top-0 z-30 flex h-12 shrink-0 items-center gap-2 rounded-t-xl border-b px-3 backdrop-blur">
            <SidebarTrigger className="-ml-1" />
            <Separator orientation="vertical" className="mr-1 data-[orientation=vertical]:h-4" />
            <div ref={setSlot} className="flex min-w-0 flex-1 items-center gap-2" />
          </header>
          <div key={location.pathname} className="mx-auto w-full max-w-[1600px] px-6 py-6">{children}</div>
        </SidebarInset>
      </SidebarProvider>
      <Palette open={paletteOpen} onOpenChange={setPaletteOpen} repositoryId={repository?.id ?? null} />
    </ShellContext>
  );
}
