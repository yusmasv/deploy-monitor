"use client";

import { PHASES } from "@/lib/phases";

export function PhaseTimeline({ phase, status }: { phase: string | null; status: string }) {
  const current = PHASES.findIndex((p) => p.id === phase);
  const failed = status === "failed" || status === "interrupted";

  return (
    <ol className="flex flex-wrap gap-1.5">
      {PHASES.map((p, i) => {
        const done = current >= 0 && i < current;
        const active = i === current;
        const tone = active && failed ? "border-rose-500/50 text-rose-300"
          : active ? "border-sky-400/50 text-sky-300"
          : done ? "border-emerald-500/30 text-emerald-400/80"
          : "border-[var(--border)] text-[var(--muted)]";
        return (
          <li key={p.id} className={`rounded-md border px-2 py-0.5 text-xs ${tone}`}>
            {p.label}
          </li>
        );
      })}
    </ol>
  );
}
