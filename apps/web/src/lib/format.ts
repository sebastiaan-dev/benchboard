import type { Verdict } from "@/gql/graphql";

export function duration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return "—";
  const [scale, unit] = seconds < 1e-3 ? [1e6, "µs"] : seconds < 1 ? [1e3, "ms"] : [1, "s"];
  const value = seconds * scale;
  return `${value.toFixed(value >= 100 ? 1 : value >= 10 ? 2 : 3)} ${unit}`;
}

/** Axis formatter that keeps one unit across a chart, chosen from its largest value. */
export function durationScale(max: number): { unit: string; scale: number } {
  if (max < 1e-3) return { unit: "µs", scale: 1e6 };
  if (max < 1) return { unit: "ms", scale: 1e3 };
  return { unit: "s", scale: 1 };
}

export function percentFromRatio(ratio: number | null | undefined, digits = 1): string {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) return "—";
  const value = (ratio - 1) * 100;
  return `${value >= 0 ? "+" : ""}${value.toFixed(digits)}%`;
}

export function bytes(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let index = 0;
  let scaled = value;
  while (scaled >= 1024 && index < units.length - 1) {
    scaled /= 1024;
    index++;
  }
  return `${scaled.toFixed(index ? 1 : 0)} ${units[index]}`;
}

export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const seconds = (Date.parse(iso) - Date.now()) / 1000;
  const format = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  const steps: [Intl.RelativeTimeFormatUnit, number][] = [
    ["year", 31536000], ["month", 2592000], ["week", 604800], ["day", 86400], ["hour", 3600], ["minute", 60],
  ];
  for (const [unit, size] of steps) if (Math.abs(seconds) >= size) return format.format(Math.round(seconds / size), unit);
  return format.format(Math.round(seconds), "second");
}

export function dateTime(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "—";
}

export const verdictLabel: Record<Verdict, string> = {
  REGRESSION: "Regression",
  IMPROVEMENT: "Improvement",
  UNCHANGED: "Unchanged",
  INCONCLUSIVE: "Inconclusive",
  FAILED: "Failed",
};

/** Semantic colors shared by charts and badges (light, dark). */
export const verdictColor: Record<Verdict | "NONE", { light: string; dark: string }> = {
  REGRESSION: { light: "#dc2626", dark: "#f87171" },
  IMPROVEMENT: { light: "#059669", dark: "#34d399" },
  UNCHANGED: { light: "#737373", dark: "#a3a3a3" },
  INCONCLUSIVE: { light: "#d97706", dark: "#fbbf24" },
  FAILED: { light: "#9333ea", dark: "#c084fc" },
  NONE: { light: "#d4d4d4", dark: "#404040" },
};

export const verdictClass: Record<Verdict, string> = {
  REGRESSION: "bg-red-500/12 text-red-700 dark:text-red-300 border-red-500/30",
  IMPROVEMENT: "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300 border-emerald-500/30",
  UNCHANGED: "bg-neutral-500/10 text-neutral-600 dark:text-neutral-300 border-neutral-500/25",
  INCONCLUSIVE: "bg-amber-500/12 text-amber-700 dark:text-amber-300 border-amber-500/30",
  FAILED: "bg-purple-500/12 text-purple-700 dark:text-purple-300 border-purple-500/30",
};

/** Diverging cell background for a relative change, saturating at ±maxChange. */
export function changeBackground(ratio: number, verdict: Verdict | null, maxChange = 0.25): string {
  if (verdict === "FAILED") return "rgb(147 51 234 / 0.25)";
  const change = Math.max(-1, Math.min(1, (ratio - 1) / maxChange));
  const strength = Math.abs(change) ** 0.7;
  const muted = verdict === "UNCHANGED" || verdict === "INCONCLUSIVE";
  const alpha = (muted ? 0.08 : 0.15) + strength * (muted ? 0.15 : 0.55);
  return change >= 0 ? `rgb(220 38 38 / ${alpha.toFixed(3)})` : `rgb(5 150 105 / ${alpha.toFixed(3)})`;
}

export function seriesName(benchmarkKey: string, caseKey: string): string {
  return caseKey === "default" ? benchmarkKey : `${benchmarkKey} · ${caseKey}`;
}
