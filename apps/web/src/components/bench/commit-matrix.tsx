import { ArrowDown, ArrowUp, Flame } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { changeBackground, duration, percentFromRatio, verdictLabel } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { Verdict } from "@/gql/graphql";

export interface MatrixComparison {
  ratio: number;
  low: number | null;
  high: number | null;
  verdict: Verdict;
  sameRun: boolean;
}

export interface MatrixCell {
  value: number | null;
  dirty: boolean;
  isReference: boolean;
  vsReference: MatrixComparison | null;
  vsPrevious: MatrixComparison | null;
  extra: number;
  profiled: boolean;
  spansGap: boolean;
}

export interface MatrixRow {
  id: string;
  name: string;
  detail: string;
  cells: MatrixCell[];
}

export interface MatrixColumn {
  position: number;
  label: string;
  subject: string;
  author: string | null;
  isBase: boolean;
}

function ComparisonLine({ title, comparison }: { title: string; comparison: MatrixComparison }) {
  return (
    <div className="flex justify-between gap-4">
      <span className="opacity-70">{title}</span>
      <span className="font-mono tabular-nums">
        {percentFromRatio(comparison.ratio, 2)} {comparison.low === null ? "(no interval)" : `[${percentFromRatio(comparison.low, 1)}, ${percentFromRatio(comparison.high, 1)}]`} {verdictLabel[comparison.verdict].toLowerCase()}
        {comparison.sameRun ? "" : " · cross-invocation"}
      </span>
    </div>
  );
}

const stepMarked = (verdict: Verdict | undefined) => verdict === "REGRESSION" || verdict === "IMPROVEMENT";

/**
 * Series × commit grid. Cells show change versus each series' reference; arrows mark commits whose
 * step from the previous measured commit is itself a confident, material change.
 */
export function CommitMatrix({ columns, rows, onSelect }: { columns: MatrixColumn[]; rows: MatrixRow[]; onSelect: (id: string) => void }) {
  const steps = columns.map((_, column) => {
    let regressions = 0;
    let improvements = 0;
    for (const row of rows) {
      const cell = row.cells[column];
      const verdict = cell.spansGap ? undefined : cell.vsPrevious?.verdict;
      if (verdict === "REGRESSION") regressions++;
      if (verdict === "IMPROVEMENT") improvements++;
    }
    return { regressions, improvements };
  });
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-separate border-spacing-0 text-sm">
        <thead>
          <tr>
            <th className="bg-card sticky left-0 z-10 min-w-56 px-3 pb-2 text-left text-xs font-medium text-muted-foreground">Series</th>
            {columns.map((column) => (
              <th key={column.position} className="px-1 pb-2 text-center align-bottom font-normal">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <div className="mx-auto grid w-20 cursor-default gap-0.5">
                      <span className="text-muted-foreground text-[10px] uppercase tracking-wide">{column.isBase ? "base" : `#${column.position}`}</span>
                      <span className="font-mono text-xs">{column.label}</span>
                    </div>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-xs">
                    <div className="font-medium">{column.subject || "(no subject)"}</div>
                    {column.author && <div className="opacity-70">{column.author}</div>}
                  </TooltipContent>
                </Tooltip>
              </th>
            ))}
          </tr>
          <tr>
            <th className="bg-card sticky left-0 z-10 border-b px-3 pb-2 text-left text-xs font-normal text-muted-foreground">Step changes</th>
            {steps.map((step, index) => (
              <th key={index} className="border-b px-1 pb-2 text-center text-xs font-normal">
                <span className="inline-flex gap-1.5 font-mono">
                  {step.regressions > 0 && <span className="text-red-600 dark:text-red-400">▲{step.regressions}</span>}
                  {step.improvements > 0 && <span className="text-emerald-600 dark:text-emerald-400">▼{step.improvements}</span>}
                  {!step.regressions && !step.improvements && <span className="text-muted-foreground/50">·</span>}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} className="group">
              <td className="bg-card group-hover:bg-muted/50 sticky left-0 z-10 border-b px-3 py-1.5">
                <button type="button" onClick={() => onSelect(row.id)} className="grid text-left hover:underline">
                  <span className="truncate font-medium">{row.name}</span>
                  <span className="text-muted-foreground truncate text-xs">{row.detail}</span>
                </button>
              </td>
              {row.cells.map((cell, index) => {
                const column = columns[index];
                const step = cell.spansGap ? undefined : cell.vsPrevious?.verdict;
                const content = cell.value === null ? (
                  <span className="text-muted-foreground/40">·</span>
                ) : cell.isReference ? (
                  <span className="text-muted-foreground font-mono text-xs">{duration(cell.value)}</span>
                ) : cell.vsReference ? (
                  <span className="font-mono text-xs font-medium tabular-nums">{percentFromRatio(cell.vsReference.ratio, 1)}</span>
                ) : <span className="font-mono text-xs">{duration(cell.value)}</span>;
                return (
                  <td key={column.position} className="border-b p-0.5">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          onClick={() => onSelect(row.id)}
                          className={cn(
                            "relative flex h-9 w-full min-w-20 items-center justify-center rounded-md transition-shadow hover:ring-2 hover:ring-ring/40",
                            cell.isReference && "ring-1 ring-inset ring-border",
                            cell.dirty && "outline-1 outline-dashed outline-amber-500/70",
                          )}
                          style={cell.vsReference ? { background: changeBackground(cell.vsReference.ratio, cell.vsReference.verdict) } : undefined}
                        >
                          {content}
                          {cell.profiled && <Flame className="absolute bottom-0.5 left-0.5 size-3 text-orange-500/80" />}
                          {stepMarked(step) && (
                            <span className={cn("absolute top-0.5 right-0.5", step === "REGRESSION" ? "text-red-600 dark:text-red-400" : "text-emerald-600 dark:text-emerald-400")}>
                              {step === "REGRESSION" ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />}
                            </span>
                          )}
                        </button>
                      </TooltipTrigger>
                      <TooltipContent className="grid min-w-64 gap-1">
                        <div className="font-medium">{row.name} @ {column.label}</div>
                        {cell.value === null ? <div className="opacity-70">Not measured at this commit</div> : <>
                          <div className="flex justify-between gap-4"><span className="opacity-70">Value</span><span className="font-mono">{duration(cell.value)}{cell.dirty ? " (dirty build)" : ""}</span></div>
                          {cell.isReference && <div className="opacity-70">Reference for this series</div>}
                          {cell.vsReference && <ComparisonLine title="vs reference" comparison={cell.vsReference} />}
                          {cell.vsPrevious && <ComparisonLine title="vs previous" comparison={cell.vsPrevious} />}
                          {cell.profiled && <div className="opacity-70">CPU profile attached</div>}
                          {cell.extra > 0 && <div className="opacity-70">{cell.extra} more measurement{cell.extra > 1 ? "s" : ""} at this commit</div>}
                        </>}
                      </TooltipContent>
                    </Tooltip>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
