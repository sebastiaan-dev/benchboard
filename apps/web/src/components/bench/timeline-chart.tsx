import { ReferenceLine } from "recharts";
import { EvilLineChart } from "@/components/evilcharts/charts/recharts-line-chart";
import type { ChartConfig } from "@/components/evilcharts/ui/recharts-chart";
import { ChartTooltip } from "@/components/evilcharts/ui/recharts-tooltip";
import { percentFromRatio } from "@/lib/format";

export interface TimelineSeries {
  id: string;
  name: string;
  /** Ratio vs reference per commit position; null where unmeasured. The reference itself is 1. */
  ratios: (number | null)[];
}

export interface TimelineCommit {
  position: number;
  label: string;
  subject: string;
}

// Categorical palette distinguishable in both themes (Okabe–Ito inspired, tuned for dark backgrounds).
const PALETTE = [
  ["#2563eb", "#60a5fa"], ["#d97706", "#fbbf24"], ["#0891b2", "#22d3ee"], ["#c026d3", "#e879f9"],
  ["#65a30d", "#a3e635"], ["#e11d48", "#fb7185"], ["#7c3aed", "#a78bfa"], ["#0d9488", "#2dd4bf"],
  ["#ea580c", "#fb923c"], ["#4f46e5", "#818cf8"],
] as const;

export function paletteColor(index: number) {
  const [light, dark] = PALETTE[index % PALETTE.length];
  return { light, dark };
}

type Row = Record<string, number | string | null>;

function TimelineTooltip({ active, payload, commits, series }: {
  active?: boolean; payload?: { dataKey: string; value: number | null; payload: Row }[];
  commits: TimelineCommit[]; series: TimelineSeries[];
}) {
  if (!active || !payload?.length) return null;
  const position = Number(payload[0].payload.position);
  const commit = commits.find((entry) => entry.position === position);
  const values = payload.filter((entry) => entry.value !== null && entry.value !== undefined)
    .sort((a, b) => Number(b.value) - Number(a.value));
  return (
    <div className="bg-background border-border/50 grid max-w-80 min-w-56 gap-1.5 rounded-lg border px-2.5 py-2 text-xs shadow-xl">
      <div className="grid gap-0.5">
        <span className="font-mono font-medium">{commit?.label}</span>
        <span className="text-muted-foreground line-clamp-2">{commit?.subject}</span>
      </div>
      {values.map((entry) => {
        const index = Number(entry.dataKey.slice(1));
        return (
          <div key={entry.dataKey} className="flex items-center gap-2">
            <span className="size-2.5 shrink-0 rounded-[2px]" style={{ background: `var(--color-${entry.dataKey}-0)` }} />
            <span className="text-muted-foreground flex-1 truncate">{series[index]?.name}</span>
            <span className="font-mono font-medium tabular-nums">{percentFromRatio(1 + Number(entry.value) / 100, 1)}</span>
          </div>
        );
      })}
    </div>
  );
}

/** Relative change of every series across the PR's commits; 0% is each series' reference. */
export function TimelineChart({ commits, series }: { commits: TimelineCommit[]; series: TimelineSeries[] }) {
  const config: ChartConfig = Object.fromEntries(series.map((entry, index) => [`s${index}`, {
    label: entry.name, colors: { light: [paletteColor(index).light], dark: [paletteColor(index).dark] },
  }]));
  const data: Row[] = commits.map((commit, column) => ({
    position: commit.position,
    label: commit.label,
    ...Object.fromEntries(series.map((entry, index) => {
      const ratio = entry.ratios[column];
      return [`s${index}`, ratio === null ? null : (ratio - 1) * 100];
    })),
  }));
  return (
    <EvilLineChart
      className="aspect-auto h-80 w-full"
      data={data}
      config={config}
      curveType="linear"
      animationType="left-to-right"
      chartProps={{ margin: { left: 4, right: 16, top: 8, bottom: 0 } }}
    >
      <EvilLineChart.Grid />
      <EvilLineChart.XAxis dataKey="label" tick={{ fontFamily: "var(--font-mono, monospace)", fontSize: 11 }} />
      <EvilLineChart.YAxis tickFormatter={(value: number) => `${value > 0 ? "+" : ""}${Math.round(value)}%`} />
      <ReferenceLine y={0} stroke="var(--muted-foreground)" strokeDasharray="4 4" strokeOpacity={0.6} />
      <ChartTooltip cursor={{ strokeDasharray: "3 3" }} content={<TimelineTooltip commits={commits} series={series} />} />
      {series.length <= 12 && (
        <EvilLineChart.Legend verticalAlign="bottom" align="left" isClickable />
      )}
      {series.map((_, index) => (
        <EvilLineChart.Line key={index} dataKey={`s${index}`} connectNulls isClickable strokeWidth={2}>
          <EvilLineChart.Dot variant="default" />
          <EvilLineChart.ActiveDot variant="colored-border" />
        </EvilLineChart.Line>
      ))}
    </EvilLineChart>
  );
}
