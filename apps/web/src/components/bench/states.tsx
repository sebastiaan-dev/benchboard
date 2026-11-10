import type { ReactNode } from "react";
import { AlertTriangle, SearchX } from "lucide-react";
import { Link } from "react-router";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { verdictLabel } from "@/lib/format";
import { Pill, verdictVar } from "@/components/kit/encodings";
import type { Verdict } from "@/gql/graphql";

export function ErrorState({ error }: { error: unknown }) {
  return (
    <Alert variant="destructive">
      <AlertTriangle />
      <AlertTitle>Could not load data</AlertTitle>
      <AlertDescription className="whitespace-pre-wrap">
        {error instanceof Error ? error.message : String(error)}
      </AlertDescription>
    </Alert>
  );
}

export function LoadingState({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-4">
      <Skeleton className="h-9 w-80" />
      <Skeleton className="h-5 w-[32rem]" />
      <div className="grid gap-4 md:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => <Skeleton key={index} className="h-24" />)}
      </div>
      {Array.from({ length: rows }, (_, index) => <Skeleton key={index} className="h-64" />)}
    </div>
  );
}

export function NotFound({ what = "page" }: { what?: string }) {
  return (
    <div className="flex flex-col items-center gap-3 py-24 text-center">
      <SearchX className="text-muted-foreground size-10" />
      <h1 className="text-xl font-semibold">No such {what}</h1>
      <Link to="/" className="text-sm underline underline-offset-4">Back to repositories</Link>
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed px-6 py-12 text-center">
      <p className="font-medium">{title}</p>
      {children && <div className="text-muted-foreground max-w-xl text-sm">{children}</div>}
    </div>
  );
}

export function VerdictBadge({ verdict, className }: { verdict: Verdict | null | undefined; className?: string }) {
  return (
    <Pill color={verdict ? verdictVar[verdict] : verdictVar.NONE} className={cn("h-5 text-[11px]", className)}>
      {verdict ? verdictLabel[verdict] : "No comparison"}
    </Pill>
  );
}

export function Hint({ children, content }: { children: ReactNode; content: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent className="max-w-xs text-pretty">{content}</TooltipContent>
    </Tooltip>
  );
}

export function Code({ children, className }: { children: ReactNode; className?: string }) {
  return <code className={cn("bg-muted rounded px-1.5 py-0.5 font-mono text-[0.8em]", className)}>{children}</code>;
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1">
      <dt className="text-muted-foreground text-xs font-medium uppercase tracking-wide">{label}</dt>
      <dd className="text-sm break-words">{children ?? <span className="text-muted-foreground">Not recorded</span>}</dd>
    </div>
  );
}
