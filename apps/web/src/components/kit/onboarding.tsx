import { useState, type ReactNode } from "react";
import { Check, CheckCircle2, Circle, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Panel, PanelHeader, Well } from "@/components/kit/panel";
import { cn } from "@/lib/utils";
import type { ComponentType } from "react";

/** A shell command with a copy button. */
export function Command({ children, className }: { children: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Well className={cn("group flex items-start gap-2 px-3 py-2", className)}>
      <code className="min-w-0 flex-1 font-mono text-xs leading-5 break-all whitespace-pre-wrap">{children}</code>
      <Button variant="ghost" size="icon" className="size-6 shrink-0" aria-label="Copy command"
        onClick={() => {
          void navigator.clipboard?.writeText(children).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          });
        }}>
        {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      </Button>
    </Well>
  );
}

export interface Step {
  title: string;
  description?: ReactNode;
  done?: boolean;
  command?: string;
}

/** Ordered checklist with progress, like the references' onboarding cards ("2 of 5 complete"). */
export function Checklist({ icon, title, subtitle, steps, footer }: {
  icon: ComponentType<{ className?: string }>; title: string; subtitle?: ReactNode; steps: Step[]; footer?: ReactNode;
}) {
  const done = steps.filter((step) => step.done).length;
  return (
    <Panel>
      <PanelHeader icon={icon} title={title} subtitle={subtitle ?? `${done} of ${steps.length} complete`} />
      <div className="px-4 pb-4">
        <div className="mb-4 flex h-1.5 gap-1">
          {steps.map((step, index) => <span key={index} className={cn("flex-1 rounded-full", step.done ? "bg-good" : "bg-muted")} />)}
        </div>
        <ol className="space-y-4">
          {steps.map((step, index) => (
            <li key={index} className="grid grid-cols-[1.25rem_1fr] gap-x-3 gap-y-1.5">
              {step.done ? <CheckCircle2 className="text-good mt-0.5 size-4" /> : <Circle className="text-muted-foreground mt-0.5 size-4" />}
              <div className={cn("text-sm font-medium", step.done && "text-muted-foreground")}>{step.title}</div>
              {step.description && <div className="text-muted-foreground col-start-2 text-sm">{step.description}</div>}
              {step.command && !step.done && <Command className="col-start-2">{step.command}</Command>}
            </li>
          ))}
        </ol>
        {footer && <div className="mt-4 border-t pt-3">{footer}</div>}
      </div>
    </Panel>
  );
}

