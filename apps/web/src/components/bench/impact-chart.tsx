import { ErrorBar, ReferenceLine } from "recharts";
import { EvilBarChart } from "@/components/evilcharts/charts/recharts-bar-chart";
import type { ChartConfig } from "@/components/evilcharts/ui/recharts-chart";
import { ChartTooltip } from "@/components/evilcharts/ui/recharts-tooltip";
import { percentFromRatio, verdictColor, verdictLabel } from "@/lib/format";
import type { Verdict } from "@/gql/graphql";

export interface ImpactDatum {
  id: string;
  name: string;
  ratio: number;
  low: number;
  high: number;
  verdict: Verdict;
  sameRun: boolean;
}

const KEYS = ["REGRESSION", "IMPROVEMENT", "UNCHANGED", "INCONCLUSIVE", "FAILED"] as const satisfies readonly Verdict[];

const config = Object.fromEntries(KEYS.map((verdict) => [verdict, {
  label: verdictLabel[verdict],
  colors: { light: [verdictColor[verdict].light], dark: [verdictColor[verdict].dark] },
}])) satisfies ChartConfig;

type Row = { name: string; datum: ImpactDatum } & Partial<Record<Verdict, number>> & Record<string, unknown>;

function ImpactTooltip({ active, payload }: { active?: boolean; payload?: { payload: Row }[] }) {
  const row = payload?.[0]?.payload;
  if (!active || !row) return null;
  const { datum } = row;
  return (
    <div className="bg-background border-border/50 grid min-w-48 gap-1.5 rounded-lg border px-2.5 py-2 text-xs shadow-xl">
      <div className="font-medium">{datum.name}</div>
      <div className="flex items-center justify-between gap-6">
        <span className="text-muted-foreground">Change</span>
        <span className="font-mono font-medium tabular-nums">{percentFromRatio(datum.ratio, 2)}</span>
      </div>
      <div className="flex items-center justify-between gap-6">
        <span className="text-muted-foreground">95% CI</span>
        <span className="font-mono tabular-nums">{percentFromRatio(datum.low, 2)} … {percentFromRatio(datum.high, 2)}</span>
      </div>
      <div className="flex items-center justify-between gap-6">
        <span className="text-muted-foreground">Verdict</span>
        <span style={{ color: `var(--color-${datum.verdict}-0)` }}>{verdictLabel[datum.verdict]}</span>
      </div>
      {!datum.sameRun && <div className="text-muted-foreground">Sides measured in different runs</div>}
    </div>
  );
}

/** Head-vs-reference change per series: verdict-coloured bars with bootstrap CI whiskers. */
export function ImpactChart({ data, onSelect }: { data: ImpactDatum[]; onSelect?: (id: string) => void }) {
  const rows: Row[] = [...data].sort((a, b) => b.ratio - a.ratio).map((datum) => {
    const change = (datum.ratio - 1) * 100;
    return {
      name: datum.name,
      datum,
      [datum.verdict]: change,
      [`${datum.verdict}_error`]: [change - (datum.low - 1) * 100, (datum.high - 1) * 100 - change],
    };
  });
  const extent = Math.max(5, ...data.flatMap((datum) => [Math.abs(datum.low - 1), Math.abs(datum.high - 1)]).map((value) => value * 100));
  const limit = Math.ceil(extent / 5) * 5;
  const present = KEYS.filter((key) => data.some((datum) => datum.verdict === key));
  const height = Math.max(160, rows.length * 34 + 56);
  return (
    <div style={{ height }}>
      <EvilBarChart
        className="h-full w-full"
        data={rows}
        config={config}
        layout="horizontal"
        stackType="stacked"
        barRadius={4}
        barCategoryGap={8}
        animationType="none"
        chartProps={{
          margin: { left: 8, right: 24, top: 4, bottom: 4 },
          onClick: (state: { activeIndex?: number | string | null }) => {
            const index = Number(state?.activeIndex);
            if (Number.isInteger(index) && rows[index]) onSelect?.(rows[index].datum.id);
          },
        }}
      >
        <EvilBarChart.Grid horizontal={false} vertical />
        <EvilBarChart.XAxis
          type="number"
          domain={[-limit, limit]}
          tickFormatter={(value: number) => `${value > 0 ? "+" : ""}${value}%`}
        />
        <EvilBarChart.YAxis type="category" dataKey="name" width={220} interval={0} tick={{ fontSize: 12 }} />
        <ChartTooltip cursor={{ fillOpacity: 0.4 }} content={<ImpactTooltip />} />
        <ReferenceLine x={0} stroke="var(--border)" strokeWidth={1.5} />
        {present.map((key) => (
          <EvilBarChart.Bar
            key={key}
            dataKey={key}
            barProps={{
              children: <ErrorBar dataKey={`${key}_error`} direction="x" width={6} strokeWidth={1.5} stroke="var(--foreground)" opacity={0.55} />,
            }}
          />
        ))}
      </EvilBarChart>
    </div>
  );
}
