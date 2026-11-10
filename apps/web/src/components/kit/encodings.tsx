import { useEffect, useState, type ReactNode } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { Verdict } from "@/gql/graphql";

export const verdictVar: Record<Verdict | "NONE" | "REFERENCE", string> = {
  REGRESSION: "var(--bad)",
  IMPROVEMENT: "var(--good)",
  UNCHANGED: "color-mix(in oklch, var(--muted-foreground) 55%, transparent)",
  INCONCLUSIVE: "var(--warn)",
  FAILED: "oklch(0.68 0.17 305)",
  NONE: "color-mix(in oklch, var(--muted-foreground) 18%, transparent)",
  REFERENCE: "var(--foreground)",
};

export function StatusDot({ color, className, pulse = false }: { color: string; className?: string; pulse?: boolean }) {
  return (
    <span className={cn("relative inline-flex size-2 shrink-0 rounded-full", className)} style={{ background: color }}>
      {pulse && <span className="absolute inset-0 animate-ping rounded-full opacity-60" style={{ background: color }} />}
    </span>
  );
}

/** Small rounded pill with a colored dot, e.g. "● Live" or "● 3 regressions". */
export function Pill({ color, children, className }: { color?: string; children: ReactNode; className?: string }) {
  return (
    <span className={cn("bg-well inline-flex h-6 items-center gap-1.5 rounded-full border px-2 text-xs whitespace-nowrap", className)}>
      {color && <StatusDot color={color} />}
      {children}
    </span>
  );
}

/** Signed relative change pill: "↑ 12.4%" in the semantic color of its verdict. */
export function DeltaPill({ ratio, verdict, digits = 1, className }: { ratio: number; verdict?: Verdict | null; digits?: number; className?: string }) {
  const change = (ratio - 1) * 100;
  const color = verdict ? verdictVar[verdict] : "var(--muted-foreground)";
  return (
    <span className={cn("inline-flex items-center gap-0.5 rounded-md px-1.5 py-0.5 font-mono text-xs font-medium tabular-nums", className)}
      style={{ color, background: `color-mix(in oklch, ${color} 14%, transparent)` }}>
      {change >= 0 ? "↑" : "↓"} {Math.abs(change).toFixed(digits)}%
    </span>
  );
}

export interface Tick {
  key: string | number;
  color: string;
  label?: ReactNode;
  emphasis?: boolean;
  outline?: boolean;
}

/** Uptime-style row of pills (one per commit), colored by state. */
export function Ticks({ ticks, className, size = "md" }: { ticks: Tick[]; className?: string; size?: "sm" | "md" }) {
  return (
    <div className={cn("flex items-end gap-[3px]", className)}>
      {ticks.map((tick) => {
        const pill = (
          <span
            // Emphasised ticks (e.g. a step change at that commit) are full height; others sit slightly shorter.
            className={cn("block shrink-0 rounded-[2px]", size === "md" ? "w-2" : "w-1.5",
              size === "md" ? (tick.emphasis ? "h-5" : "h-4") : (tick.emphasis ? "h-4" : "h-3"))}
            style={tick.outline ? { boxShadow: `inset 0 0 0 1.5px ${tick.color}` } : { background: tick.color, opacity: tick.emphasis ? 1 : 0.75 }}
          />
        );
        return tick.label ? (
          <Tooltip key={tick.key}>
            <TooltipTrigger asChild>{pill}</TooltipTrigger>
            <TooltipContent className="max-w-xs">{tick.label}</TooltipContent>
          </Tooltip>
        ) : <span key={tick.key}>{pill}</span>;
      })}
    </div>
  );
}

/** Tiny line chart; nulls break nothing (they are skipped). */
export function Sparkline({ values, width = 96, height = 24, color = "var(--foreground)", reference, className }: {
  values: (number | null)[]; width?: number; height?: number; color?: string; reference?: number; className?: string;
}) {
  const points = values.map((value, index) => ({ value, index })).filter((point): point is { value: number; index: number } => point.value !== null);
  if (points.length < 2) return <svg width={width} height={height} className={className} />;
  const all = [...points.map((point) => point.value), ...(reference !== undefined ? [reference] : [])];
  const min = Math.min(...all), max = Math.max(...all);
  const span = max - min || Math.abs(max) * 0.1 || 1;
  const x = (index: number) => 2 + (index / Math.max(1, values.length - 1)) * (width - 4);
  const y = (value: number) => 2 + (1 - (value - min) / span) * (height - 4);
  const d = points.map((point, i) => `${i ? "L" : "M"}${x(point.index).toFixed(1)},${y(point.value).toFixed(1)}`).join(" ");
  const last = points[points.length - 1];
  return (
    <svg width={width} height={height} className={cn("overflow-visible", className)}>
      {reference !== undefined && <line x1={0} x2={width} y1={y(reference)} y2={y(reference)} stroke="var(--border)" strokeDasharray="2 2" />}
      <path d={d} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={x(last.index)} cy={y(last.value)} r={2.25} fill={color} />
    </svg>
  );
}

/**
 * Point estimate with a 95% interval on a symmetric percent axis, a zero line and a shaded
 * threshold band ("Uplift vs control · 95% intervals").
 */
export function IntervalGlyph({ ratio, low, high, verdict, threshold, extent, width = 140, height = 18, className }: {
  ratio: number; low: number; high: number; verdict: Verdict; threshold: number; extent: number; width?: number; height?: number; className?: string;
}) {
  const scale = (value: number) => width / 2 + ((value - 1) / extent) * (width / 2);
  const clamp = (value: number) => Math.max(1, Math.min(width - 1, value));
  const color = verdictVar[verdict];
  const mid = height / 2;
  return (
    <svg width={width} height={height} className={cn("overflow-visible", className)}>
      <rect x={scale(1 - threshold)} width={scale(1 + threshold) - scale(1 - threshold)} y={2} height={height - 4} rx={2}
        fill="color-mix(in oklch, var(--muted-foreground) 12%, transparent)" />
      <line x1={width / 2} x2={width / 2} y1={0} y2={height} stroke="var(--muted-foreground)" strokeOpacity={0.5} />
      <line x1={clamp(scale(low))} x2={clamp(scale(high))} y1={mid} y2={mid} stroke={color} strokeWidth={2} strokeLinecap="round" />
      <circle cx={clamp(scale(ratio))} cy={mid} r={3.5} fill={color} stroke="var(--card)" strokeWidth={1.5} />
    </svg>
  );
}

export interface Segment {
  key: string;
  label: ReactNode;
  value: number;
  color: string;
}

/** Stacked proportion bar with a legend that doubles as a table (malikyoloo "Fleet status"). */
export function SegmentedBar({ segments, legend = true, className }: { segments: Segment[]; legend?: boolean; className?: string }) {
  const total = segments.reduce((sum, segment) => sum + segment.value, 0);
  return (
    <div className={cn("space-y-3", className)}>
      <div className="flex h-2 gap-1">
        {segments.filter((segment) => segment.value > 0).map((segment) => (
          <span key={segment.key} className="rounded-full" style={{ flexGrow: segment.value, background: segment.color }} />
        ))}
        {total === 0 && <span className="bg-muted flex-1 rounded-full" />}
      </div>
      {legend && (
        <div className="grid gap-1.5">
          {segments.map((segment) => (
            <div key={segment.key} className="flex items-center gap-2 text-sm">
              <StatusDot color={segment.color} />
              <span className="flex-1 truncate">{segment.label}</span>
              <span className="text-muted-foreground font-mono text-xs tabular-nums">{total ? Math.round((segment.value / total) * 100) : 0}%</span>
              <span className="w-6 text-right font-mono tabular-nums">{segment.value}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Horizontal meter of thin ticks (disarto_max "FLEET UTIL"). */
export function Meter({ value, max = 1, color = "var(--foreground)", ticks = 28, className }: {
  value: number; max?: number; color?: string; ticks?: number; className?: string;
}) {
  const filled = Math.round((Math.max(0, Math.min(max, value)) / max) * ticks);
  return (
    <div className={cn("flex h-3 items-stretch gap-[2px]", className)}>
      {Array.from({ length: ticks }, (_, index) => (
        <span key={index} className="w-[3px] rounded-[1px]" style={{ background: index < filled ? color : "color-mix(in oklch, var(--muted-foreground) 22%, transparent)" }} />
      ))}
    </div>
  );
}

/** Small segmented control styled like the references' "Table · Chart · SQL" switchers. */
export function Segmented<T extends string>({ value, options, onChange, className }: {
  value: T; options: { value: T; label: ReactNode }[]; onChange: (value: T) => void; className?: string;
}) {
  return (
    <div className={cn("bg-well inline-flex h-8 items-center gap-0.5 rounded-lg border p-0.5", className)}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
          className={cn("h-full rounded-md px-2.5 text-xs font-medium transition-colors",
            option.value === value ? "bg-accent text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function useElementWidth<T extends HTMLElement>() {
  const [element, setElement] = useState<T | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return [setElement, width] as const;
}

/** IntervalGlyph that fills its container's width. */
export function WideInterval(props: Omit<Parameters<typeof IntervalGlyph>[0], "width">) {
  const [ref, width] = useElementWidth<HTMLDivElement>();
  return <div ref={ref} className="w-full">{width > 0 && <IntervalGlyph {...props} width={width} />}</div>;
}
