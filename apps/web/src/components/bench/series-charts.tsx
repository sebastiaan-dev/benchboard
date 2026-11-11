import { Area, ComposedChart, ReferenceLine, Scatter, XAxis, YAxis, CartesianGrid } from "recharts";
import { EvilComposedChart } from "@/components/evilcharts/charts/recharts-composed-chart";
import { ChartContainer, type ChartConfig } from "@/components/evilcharts/ui/recharts-chart";
import { ChartTooltip } from "@/components/evilcharts/ui/recharts-tooltip";
import { duration, durationScale } from "@/lib/format";
import { useElementWidth } from "@/components/kit/encodings";

export interface TrendPoint {
  position: number;
  label: string;
  subject: string;
  value: number | null;
  q1: number | null;
  q3: number | null;
  min: number | null;
  max: number | null;
  n: number | null;
  dirty: boolean;
}

const trendConfig = {
  value: { label: "Statistic", colors: { light: ["#2563eb"], dark: ["#60a5fa"] } },
} satisfies ChartConfig;

type TrendRow = { label: string; value: number | null; iqr: [number, number] | null; range: [number, number] | null; point: TrendPoint };

function TrendTooltip({ active, payload, statistic }: { active?: boolean; payload?: { payload: TrendRow }[]; statistic: string }) {
  const row = payload?.[0]?.payload;
  if (!active || !row) return null;
  const { point } = row;
  const line = (name: string, value: string) => (
    <div className="flex justify-between gap-6">
      <span className="text-muted-foreground">{name}</span>
      <span className="font-mono tabular-nums">{value}</span>
    </div>
  );
  return (
    <div className="bg-background border-border/50 grid min-w-52 max-w-72 gap-1 rounded-lg border px-2.5 py-2 text-xs shadow-xl">
      <span className="font-mono font-medium">{point.label}{point.dirty ? " + dirty" : ""}</span>
      <span className="text-muted-foreground mb-1 line-clamp-2">{point.subject}</span>
      {point.value === null ? <span className="text-muted-foreground">Not measured</span> : <>
        {line(statistic, duration(point.value))}
        {line("IQR", `${duration(point.q1)} – ${duration(point.q3)}`)}
        {line("Range", `${duration(point.min)} – ${duration(point.max)}`)}
        {line("Samples", String(point.n))}
      </>}
    </div>
  );
}

/** Absolute timings per commit: statistic line over an interquartile band and a faint min–max envelope. */
export function TrendChart({ points, reference, statistic, highlight, steps = [] }: {
  points: TrendPoint[]; reference: number | null; statistic: string;
  /** Label of the commit under inspection (vertical marker). */
  highlight?: string;
  /** Commits with confident step changes (thin red/green markers). */
  steps?: { label: string; regression: boolean }[];
}) {
  const { scale, unit } = durationScale(Math.max(...points.map((point) => point.max ?? 0)));
  const s = (value: number | null) => value === null ? null : value * scale;
  const data: TrendRow[] = points.map((point) => ({
    label: point.label,
    value: s(point.value),
    iqr: point.q1 === null || point.q3 === null ? null : [point.q1 * scale, point.q3 * scale],
    range: point.min === null || point.max === null ? null : [point.min * scale, point.max * scale],
    point,
  }));
  return (
    <EvilComposedChart className="aspect-auto h-64 w-full" data={data} config={trendConfig} curveType="linear" animationType="none"
      chartProps={{ margin: { left: 4, right: 12, top: 8, bottom: 0 } }}>
      <EvilComposedChart.Grid />
      <EvilComposedChart.XAxis dataKey="label" tick={{ fontFamily: "var(--font-mono, monospace)", fontSize: 11 }} />
      <EvilComposedChart.YAxis domain={["auto", "auto"]} tickFormatter={(value: number) => `${+value.toPrecision(3)} ${unit}`} />
      {steps.map((step) => (
        <ReferenceLine key={`step-${step.label}`} x={step.label} stroke={step.regression ? "var(--bad)" : "var(--good)"} strokeOpacity={0.55} />
      ))}
      {highlight && <ReferenceLine x={highlight} stroke="var(--foreground)" strokeWidth={1.5} strokeDasharray="2 3" />}
      <Area dataKey="range" type="linear" connectNulls stroke="none" fill="var(--color-value-0)" fillOpacity={0.07} isAnimationActive={false} activeDot={false} tooltipType="none" />
      <Area dataKey="iqr" type="linear" connectNulls stroke="none" fill="var(--color-value-0)" fillOpacity={0.2} isAnimationActive={false} activeDot={false} tooltipType="none" />
      {reference !== null && (
        <ReferenceLine y={reference * scale} stroke="var(--muted-foreground)" strokeDasharray="4 4"
          label={{ value: "reference", position: "insideTopLeft", fill: "var(--muted-foreground)", fontSize: 10 }} />
      )}
      <ChartTooltip content={<TrendTooltip statistic={statistic} />} />
      <EvilComposedChart.Line dataKey="value" connectNulls>
        <EvilComposedChart.Dot variant="border" />
        <EvilComposedChart.ActiveDot variant="colored-border" />
      </EvilComposedChart.Line>
    </EvilComposedChart>
  );
}

export interface SampleSet {
  position: number;
  label: string;
  times: number[];
  dirty: boolean;
}

const sampleConfig = {
  samples: { label: "Samples", colors: { light: ["#2563eb"], dark: ["#60a5fa"] } },
  dirty: { label: "Dirty build", colors: { light: ["#d97706"], dark: ["#fbbf24"] } },
} satisfies ChartConfig;

/** Deterministic jitter so the strip plot does not move between renders. */
function jitter(index: number) {
  const x = Math.sin(index * 12.9898) * 43758.5453;
  return (x - Math.floor(x) - 0.5) * 0.5;
}

/** Every raw sample per commit (strip plot), revealing outliers, multimodality and drift that summaries hide. */
export function SamplesChart({ sets, commits }: { sets: SampleSet[]; commits: { position: number; label: string }[] }) {
  const { scale, unit } = durationScale(Math.max(0, ...sets.flatMap((set) => set.times)));
  const columns = new Map(commits.map((commit, index) => [commit.position, index]));
  const toPoints = (set: SampleSet) => set.times.map((time, index) => ({ x: columns.get(set.position)! + jitter(index + set.position * 997), y: time * scale }));
  const clean = sets.filter((set) => !set.dirty).flatMap(toPoints);
  const dirty = sets.filter((set) => set.dirty).flatMap(toPoints);
  return (
    <ChartContainer config={sampleConfig} className="aspect-auto h-64 w-full">
      <ComposedChart margin={{ left: 4, right: 12, top: 8, bottom: 0 }}>
        <CartesianGrid vertical={false} strokeDasharray="3 3" />
        <XAxis type="number" dataKey="x" domain={[-0.5, commits.length - 0.5]} ticks={commits.map((_, index) => index)}
          tickFormatter={(value: number) => commits[value]?.label ?? ""} tickLine={false} axisLine={false} tickMargin={8}
          tick={{ fontFamily: "var(--font-mono, monospace)", fontSize: 11 }} allowDataOverflow />
        <YAxis type="number" dataKey="y" domain={["auto", "auto"]} tickLine={false} axisLine={false} width="auto"
          tickFormatter={(value: number) => `${+value.toPrecision(3)} ${unit}`} />
        <Scatter data={clean} fill="var(--color-samples-0)" fillOpacity={0.55} shape="circle" isAnimationActive={false} legendType="none" />
        {dirty.length > 0 && <Scatter data={dirty} fill="var(--color-dirty-0)" fillOpacity={0.7} shape="diamond" isAnimationActive={false} />}
      </ComposedChart>
    </ChartContainer>
  );
}

/**
 * Two-row strip plot of every sample (base above head) on a shared axis, with each side's IQR band
 * and median tick. Unlike overlaid histograms it stays readable when the distributions do not overlap.
 */
export function PairedStrip({ base, head, labels = { base: "base", head: "head" } }: {
  base: number[]; head: number[]; labels?: { base: string; head: string };
}) {
  const [ref, width] = useElementWidth<HTMLDivElement>();
  const all = [...base, ...head];
  if (!all.length) return null;
  const lo = Math.min(...all), hi = Math.max(...all);
  const pad = (hi - lo) * 0.06 || hi * 0.02 || 1e-6;
  const min = lo - pad, max = hi + pad;
  const { scale, unit } = durationScale(hi);
  const left = 56, right = 12, row = 46, top = 16;
  const inner = Math.max(10, width - left - right);
  const x = (value: number) => left + ((value - min) / (max - min)) * inner;
  const quantile = (values: number[], p: number) => {
    const sorted = [...values].sort((a, b) => a - b);
    const index = (sorted.length - 1) * p;
    const floor = Math.floor(index);
    return sorted[floor] + (sorted[Math.ceil(index)] - sorted[floor]) * (index - floor);
  };
  const ticks = Array.from({ length: 5 }, (_, index) => min + ((max - min) * index) / 4);
  const rows = [
    { key: "base", values: base, label: labels.base, color: "var(--muted-foreground)" },
    { key: "head", values: head, label: labels.head, color: "var(--info)" },
  ];
  return (
    <div ref={ref} className="w-full">
      {width > 0 && (
        <svg width={width} height={top + rows.length * row + 34} className="overflow-visible">
          {ticks.map((tick) => (
            <g key={tick}>
              <line x1={x(tick)} x2={x(tick)} y1={top} y2={top + rows.length * row + 12} stroke="var(--border)" strokeDasharray="3 3" />
              <text x={x(tick)} y={top + rows.length * row + 26} textAnchor="middle" fontSize={10} fill="var(--muted-foreground)" fontFamily="var(--font-mono)">
                {+(tick * scale).toPrecision(3)} {unit}
              </text>
            </g>
          ))}
          {rows.map((entry, index) => {
            const y = top + index * row + row / 2;
            if (!entry.values.length) return null;
            const q1 = quantile(entry.values, 0.25), q3 = quantile(entry.values, 0.75), median = quantile(entry.values, 0.5);
            return (
              <g key={entry.key}>
                <text x={0} y={y + 4} fontSize={11} fill="var(--muted-foreground)" fontFamily="var(--font-mono)">{entry.label}</text>
                <rect x={x(q1)} width={Math.max(2, x(q3) - x(q1))} y={y - 11} height={22} rx={5} fill={entry.color} fillOpacity={0.12} />
                {entry.values.map((value, sample) => (
                  <circle key={sample} cx={x(value)} cy={y + jitter(sample + index * 7919) * 28} r={2.4} fill={entry.color} fillOpacity={0.65} />
                ))}
                <line x1={x(median)} x2={x(median)} y1={y - 14} y2={y + 14} stroke={entry.color} strokeWidth={2} />
                <text x={x(median)} y={index === 0 ? y - 17 : y + 25} textAnchor="middle" fontSize={10} fill={entry.color} fontFamily="var(--font-mono)">p50 {duration(median)}</text>
              </g>
            );
          })}
        </svg>
      )}
    </div>
  );
}
