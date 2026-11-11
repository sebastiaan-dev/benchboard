import { memo, useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { childrenOf, functionLibrary, functionName, isThread, totals, type CallTree, type DiffTree, type Metric } from "@benchboard/core/profile-tree";
import { cn } from "@/lib/utils";

export interface FlameNode {
  id: number;
  name: string;
  library: string | null;
  /** Width weight (milliseconds per iteration). */
  value: number;
  self: number;
  /** Differential mode: per-iteration milliseconds on each side. */
  base?: number;
  head?: number;
  thread?: boolean;
  depth: number;
  parent: FlameNode | null;
  children: FlameNode[];
}

/** Hierarchy from a call tree; widths in milliseconds per iteration of the chosen metric, heaviest children first. */
export function fromCallTree(tree: CallTree, metric: Metric, iterations = 1): FlameNode {
  const children = childrenOf(tree);
  const inclusive = totals(tree, metric);
  const self = tree.nodes[metric];
  const scale = 1 / Math.max(1, iterations);
  const build = (node: number, parent: FlameNode | null, depth: number): FlameNode => {
    const func = tree.nodes.func[node];
    const result: FlameNode = {
      id: node, name: node === 0 ? "all" : functionName(tree, func), library: node === 0 ? null : functionLibrary(tree, func),
      value: inclusive[node] * scale, self: self[node] * scale,
      thread: node !== 0 && isThread(tree, func), depth, parent, children: [],
    };
    result.children = children[node].map((child) => build(child, result, depth + 1)).filter((child) => child.value > 0)
      .sort((a, b) => b.value - a.value);
    return result;
  };
  return build(0, null, 0);
}

/** Differential hierarchy; widths follow one side so nested widths stay consistent. */
export function fromDiffTree(tree: DiffTree, side: "head" | "base"): FlameNode {
  const children: number[][] = tree.nodes.func.map(() => []);
  for (let node = 1; node < tree.nodes.parent.length; node++) children[tree.nodes.parent[node]].push(node);
  const name = (func: number) => func < 0 ? "all" : tree.strings[tree.funcs.name[func]];
  const lib = (func: number) => func < 0 || tree.funcs.lib[func] < 0 ? null : tree.strings[tree.funcs.lib[func]];
  const build = (node: number, parent: FlameNode | null, depth: number): FlameNode => {
    const func = tree.nodes.func[node];
    const result: FlameNode = {
      id: node, name: name(func), library: lib(func), value: tree.nodes[side][node],
      self: side === "head" ? tree.nodes.headSelf[node] : tree.nodes.baseSelf[node],
      base: tree.nodes.base[node], head: tree.nodes.head[node], thread: lib(func) === "(thread)", depth, parent, children: [],
    };
    result.children = children[node].map((child) => build(child, result, depth + 1)).filter((child) => child.value > 0)
      .sort((a, b) => b.value - a.value);
    return result;
  };
  return build(0, null, 0);
}

function hash(text: string): number {
  let value = 2166136261;
  for (let i = 0; i < text.length; i++) value = Math.imul(value ^ text.charCodeAt(i), 16777619);
  return value >>> 0;
}

function libraryColor(node: FlameNode): string {
  if (node.depth === 0) return "oklch(0.7 0.01 264)";
  if (node.thread) return "oklch(0.76 0.02 264)";
  // Warm hues for the profiled program, cooler hues for system and runtime libraries.
  const library = node.library ?? "";
  const system = /^(lib(system|c|dyld|objc|pthread|m|stdc\+\+|c\+\+)|dyld|ld-linux|libsystem_)/.test(library);
  // Hue varies by function (classic flame graph palette), so single-binary programs stay readable.
  const h = hash(node.name);
  const hue = system ? 200 + (h % 50) : 25 + (h % 55);
  const light = 0.74 + ((h >>> 8) % 10) / 100;
  return `oklch(${light.toFixed(2)} ${system ? 0.06 : 0.11} ${hue})`;
}

export function diffColor(base: number, head: number): string {
  const max = Math.max(base, head);
  if (max <= 0) return "oklch(0.74 0.008 264)";
  const relative = (head - base) / max;
  if (Math.abs(relative) < 0.03) return "oklch(0.74 0.008 264)";
  // Tints stay light enough for dark text; chroma grows with the relative change.
  const strength = Math.min(1, Math.abs(relative)) ** 0.8;
  const light = 0.84 - strength * 0.16;
  return relative > 0 ? `oklch(${light.toFixed(3)} ${(0.05 + strength * 0.13).toFixed(3)} 25)` : `oklch(${light.toFixed(3)} ${(0.04 + strength * 0.1).toFixed(3)} 245)`;
}

const ROW = 22;

interface Layout {
  node: FlameNode;
  x: number;
  width: number;
  depth: number;
}

function layout(focus: FlameNode, width: number): { boxes: Layout[]; depth: number } {
  const boxes: Layout[] = [];
  // Ancestors of the zoomed node span the full width, as in speedscope/Firefox Profiler.
  const ancestors: FlameNode[] = [];
  for (let node = focus.parent; node; node = node.parent) ancestors.unshift(node);
  ancestors.forEach((node, depth) => boxes.push({ node, x: 0, width, depth }));
  let maxDepth = ancestors.length;
  const scale = focus.value > 0 ? width / focus.value : 0;
  const stack: [FlameNode, number, number][] = [[focus, 0, ancestors.length]];
  while (stack.length) {
    const [node, x, depth] = stack.pop()!;
    const w = node.value * scale;
    if (w < 1.5) continue;
    boxes.push({ node, x, width: w, depth });
    maxDepth = Math.max(maxDepth, depth);
    let offset = x;
    for (const child of node.children) {
      stack.push([child, offset, depth + 1]);
      offset += child.value * scale;
    }
  }
  return { boxes, depth: maxDepth + 1 };
}

const Boxes = memo(function Boxes({ boxes, diff, matches, focus }: {
  boxes: Layout[]; diff: boolean; matches: Set<FlameNode> | null; focus: FlameNode;
}) {
  return boxes.map(({ node, x, width, depth }) => {
    const dimmed = matches !== null && !matches.has(node);
    const above = depth < focus.depth;
    return (
      <div
        key={`${node.id}:${depth}`}
        data-node={node.id}
        className={cn("absolute cursor-pointer overflow-hidden rounded-[4px] px-1.5 text-[11px] leading-[18px] whitespace-nowrap text-neutral-950 transition-opacity hover:brightness-110",
          above && "opacity-55")}
        style={{
          // Small gaps between blocks give the rounded, tiled look of the references.
          left: x + 1, top: depth * ROW + 1, width: Math.max(1, width - 2), height: ROW - 2,
          background: diff && node.base !== undefined ? diffColor(node.base, node.head ?? 0) : libraryColor(node),
          opacity: dimmed ? 0.25 : undefined,
        }}
      >
        {width > 32 ? node.name : ""}
      </div>
    );
  });
});

export interface FlameGraphProps {
  root: FlameNode;
  diff?: boolean;
  search?: string;
  className?: string;
  /** Total of the whole profile, for percentages. */
  total?: number;
}

export function FlameGraph({ root, diff = false, search = "", className, total = root.value }: FlameGraphProps) {
  const container = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [focus, setFocus] = useState<FlameNode>(root);
  const [hover, setHover] = useState<{ node: FlameNode; x: number; y: number } | null>(null);
  // Keyboard cursor: arrows move between frames, Enter zooms, Escape zooms out.
  const [cursor, setCursor] = useState<FlameNode | null>(null);
  useEffect(() => { setFocus(root); setCursor(null); }, [root]);
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const { boxes, depth } = useMemo(() => layout(focus, width), [focus, width]);
  const byId = useMemo(() => new Map(boxes.map((box) => [box.node.id, box.node])), [boxes]);
  const matches = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return null;
    const found = new Set<FlameNode>();
    const visit = (node: FlameNode) => {
      if (node.name.toLowerCase().includes(query)) found.add(node);
      node.children.forEach(visit);
    };
    visit(root);
    return found;
  }, [root, search]);
  const matchedShare = useMemo(() => {
    if (!matches) return null;
    let sum = 0;
    const visit = (node: FlameNode) => {
      if (matches.has(node)) { sum += node.value; return; }
      node.children.forEach(visit);
    };
    visit(root);
    return root.value ? sum / root.value : 0;
  }, [matches, root]);

  const nodeAt = (event: MouseEvent) => {
    const id = (event.target as HTMLElement).closest<HTMLElement>("[data-node]")?.dataset.node;
    return id === undefined ? undefined : byId.get(Number(id));
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const current = cursor ?? focus;
    const visible = (node: FlameNode | null | undefined) => node && (byId.has(node.id) || node === focus) ? node : null;
    let next: FlameNode | null = null;
    const siblings = current.parent?.children.filter((node) => byId.has(node.id)) ?? [];
    switch (event.key) {
      case "ArrowUp": next = current.parent; break;
      case "ArrowDown": next = visible(current.children.find((node) => byId.has(node.id))); break;
      case "ArrowLeft": next = siblings[siblings.indexOf(current) - 1] ?? null; break;
      case "ArrowRight": next = siblings[siblings.indexOf(current) + 1] ?? null; break;
      case "Enter": case " ": setFocus(current); event.preventDefault(); return;
      case "Escape": if (focus.parent) { setFocus(focus.parent); setCursor(focus.parent); event.preventDefault(); } return;
      default: return;
    }
    event.preventDefault();
    if (next) setCursor(next);
  };
  const ms = (value: number | undefined) => value === undefined ? "—" : Math.abs(value) >= 1000 ? `${(value / 1000).toFixed(2)} s` : `${value.toFixed(Math.abs(value) >= 10 ? 1 : 2)} ms`;
  const pct = (value: number) => `${(total ? (value / total) * 100 : 0).toFixed(2)}%`;
  const crumbs: FlameNode[] = [];
  for (let node: FlameNode | null = focus; node; node = node.parent) crumbs.unshift(node);

  const describedNode = cursor ?? hover?.node ?? null;
  const describedBy = `flame-${root.id}-${root.name.length}-description`;
  const description = describedNode ? (diff && describedNode.base !== undefined
    ? `${describedNode.name}${describedNode.library ? ` in ${describedNode.library}` : ""}: base ${ms(describedNode.base)}, head ${ms(describedNode.head)}, change ${ms((describedNode.head ?? 0) - describedNode.base)}.`
    : `${describedNode.name}${describedNode.library ? ` in ${describedNode.library}` : ""}: total ${ms(describedNode.value)} (${pct(describedNode.value)}), self ${ms(describedNode.self)}.`)
    : `Showing ${focus.name}: ${ms(focus.value)}.`;

  return (
    <div className={cn("space-y-2", className)}>
      {/* Text equivalent of the hovered or keyboard-selected frame for screen readers and keyboard users. */}
      <p id={describedBy} className="text-muted-foreground min-h-4 truncate font-mono text-[11px]" aria-live="polite">{description}</p>
      <div className="text-muted-foreground flex min-h-6 flex-wrap items-center gap-1 text-xs">
        {crumbs.map((node, index) => (
          <span key={node.id} className="flex items-center gap-1">
            {index > 0 && <span>›</span>}
            <button type="button" className={cn("max-w-64 truncate hover:underline", node === focus && "text-foreground font-medium")} onClick={() => setFocus(node)}>
              {node.name}
            </button>
          </span>
        ))}
        {matchedShare !== null && <span className="ml-auto">{matches!.size} matching frames · {(matchedShare * 100).toFixed(1)}% of time</span>}
      </div>
      <div
        ref={container}
        className="bg-well focus-visible:ring-ring/60 relative w-full rounded-xl border p-1 outline-none focus-visible:ring-2"
        tabIndex={0}
        role="application"
        aria-roledescription="flame graph"
        aria-label="Flame graph. Arrow keys move between frames, Enter zooms into the selected frame, Escape zooms out."
        aria-describedby={describedBy}
        onKeyDown={onKeyDown}
        style={{ height: depth * ROW + 10 }}
        onMouseMove={(event) => {
          const node = nodeAt(event);
          setHover(node ? { node, x: event.clientX, y: event.clientY } : null);
        }}
        onMouseLeave={() => setHover(null)}
        onClick={(event) => {
          const node = nodeAt(event);
          if (node) setFocus(node === focus && node.parent ? node.parent : node);
        }}
      >
        <div className="absolute inset-1 overflow-hidden rounded-lg">
          <Boxes boxes={boxes} diff={diff} matches={matches} focus={focus} />
          {cursor && (() => {
            const box = boxes.find((entry) => entry.node === cursor);
            return box ? <div className="pointer-events-none absolute rounded-[4px] ring-2 ring-foreground" style={{ left: box.x + 1, top: box.depth * ROW + 1, width: Math.max(2, box.width - 2), height: ROW - 2 }} /> : null;
          })()}
        </div>
        {hover && (
          <div
            // Fixed positioning escapes the card's overflow clipping; flip near the viewport edges.
            className="bg-popover text-popover-foreground pointer-events-none fixed z-50 grid max-w-[36rem] gap-1 rounded-md border px-2.5 py-2 text-xs shadow-lg"
            style={{
              left: Math.min(hover.x + 12, window.innerWidth - 440),
              ...(hover.y > window.innerHeight - 180 ? { bottom: window.innerHeight - hover.y + 12 } : { top: hover.y + 16 }),
            }}
          >
            <div className="font-mono font-medium break-all">{hover.node.name}</div>
            {hover.node.library && <div className="text-muted-foreground">{hover.node.library}</div>}
            {diff && hover.node.base !== undefined ? <>
              <div className="flex justify-between gap-6"><span className="text-muted-foreground">Base total</span><span className="font-mono">{ms(hover.node.base)}</span></div>
              <div className="flex justify-between gap-6"><span className="text-muted-foreground">Head total</span><span className="font-mono">{ms(hover.node.head)}</span></div>
              <div className="flex justify-between gap-6">
                <span className="text-muted-foreground">Change</span>
                <span className={cn("font-mono font-medium", (hover.node.head ?? 0) > hover.node.base ? "text-bad" : "text-info")}>
                  {(hover.node.head ?? 0) - hover.node.base >= 0 ? "+" : ""}{ms((hover.node.head ?? 0) - hover.node.base)}
                  {hover.node.base > 0 ? ` (${(((hover.node.head ?? 0) / hover.node.base - 1) * 100).toFixed(1)}%)` : " (new)"}
                </span>
              </div>
            </> : <>
              <div className="flex justify-between gap-6"><span className="text-muted-foreground">Total</span><span className="font-mono">{ms(hover.node.value)} · {pct(hover.node.value)}</span></div>
              <div className="flex justify-between gap-6"><span className="text-muted-foreground">Self</span><span className="font-mono">{ms(hover.node.self)} · {pct(hover.node.self)}</span></div>
            </>}
            <div className="text-muted-foreground">Click to zoom{hover.node === focus ? " out" : ""}</div>
          </div>
        )}
      </div>
    </div>
  );
}
