import type { ComponentType, ReactNode } from "react";
import { cn } from "@/lib/utils";

/** Card surface: hairline border, one step above the canvas. */
export function Panel({ className, children, id }: { className?: string; children: ReactNode; id?: string }) {
  return (
    <section id={id} className={cn("bg-card text-card-foreground rounded-2xl border shadow-[0_1px_0_0_oklch(1_0_0/3%)_inset]", className)}>
      {children}
    </section>
  );
}

/** Icon tile + title + one-line subtitle, with actions on the right. */
export function PanelHeader({ icon: Icon, title, subtitle, actions, className }: {
  icon?: ComponentType<{ className?: string }>;
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <header className={cn("flex items-start gap-3 px-4 pt-4 pb-3", className)}>
      {Icon && (
        <span className="bg-well text-muted-foreground flex size-8 shrink-0 items-center justify-center rounded-lg border">
          <Icon className="size-4" />
        </span>
      )}
      <div className="min-w-0 flex-1">
        <h2 className="truncate text-sm leading-5 font-medium">{title}</h2>
        {subtitle && <p className="text-muted-foreground truncate text-xs leading-4">{subtitle}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </header>
  );
}

export function PanelBody({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn("px-4 pb-4", className)}>{children}</div>;
}

/** Darker inset area inside a panel for charts and key/value blocks. */
export function Well({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn("bg-well rounded-xl border", className)}>{children}</div>;
}

export function PanelFooter({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <footer className={cn("text-muted-foreground flex items-center gap-3 border-t px-4 py-2.5 font-mono text-[11px] tracking-wide uppercase", className)}>
      {children}
    </footer>
  );
}

/** Uppercase mono micro label ("TOKENS SERVED / S"). */
export function MicroLabel({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("text-muted-foreground font-mono text-[10.5px] font-medium tracking-[0.08em] uppercase", className)}>{children}</div>;
}

export function Stat({ label, value, unit, detail, tone, className }: {
  label: ReactNode; value: ReactNode; unit?: ReactNode; detail?: ReactNode; tone?: "good" | "bad" | "warn"; className?: string;
}) {
  return (
    <div className={cn("min-w-0", className)}>
      <MicroLabel>{label}</MicroLabel>
      <div className={cn("mt-1.5 flex items-baseline gap-1 text-2xl font-semibold tracking-tight tabular-nums",
        tone === "good" && "text-good", tone === "bad" && "text-bad", tone === "warn" && "text-warn")}>
        {value}{unit && <span className="text-muted-foreground text-sm font-normal">{unit}</span>}
      </div>
      {detail && <div className="text-muted-foreground mt-1 truncate font-mono text-[11px]">{detail}</div>}
    </div>
  );
}

/** Divided row of stats inside a panel. */
export function StatStrip({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("grid divide-y sm:divide-x sm:divide-y-0 [&>*]:px-4 [&>*]:py-4", className)}>{children}</div>;
}

export function KeyValues({ rows, className }: { rows: [ReactNode, ReactNode][]; className?: string }) {
  return (
    <Well className={cn("divide-y overflow-hidden", className)}>
      {rows.map(([key, value], index) => (
        <div key={index} className="grid grid-cols-[8.5rem_1fr] gap-3 px-3 py-1.5 font-mono text-xs">
          <span className="text-muted-foreground truncate">{key}</span>
          <span className="min-w-0 break-words">{value ?? <span className="text-muted-foreground/60">—</span>}</span>
        </div>
      ))}
    </Well>
  );
}

export function SectionLabel({ children, count, className }: { children: ReactNode; count?: number; className?: string }) {
  return (
    <div className={cn("flex items-center gap-2 px-1", className)}>
      <MicroLabel>{children}</MicroLabel>
      {count !== undefined && <span className="bg-muted text-muted-foreground rounded px-1.5 font-mono text-[10px]">{count}</span>}
    </div>
  );
}
