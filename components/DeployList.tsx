"use client";

import Link from "next/link";
import { STATUS_STYLE, formatRelative } from "@/lib/format";

export interface DeploySummary {
  id: string; project: string; status: string; created_at: number; sha: string | null;
}

export function DeployList({ deploys, activeId }: { deploys: DeploySummary[]; activeId?: string }) {
  if (deploys.length === 0) {
    return <p className="px-3 py-6 text-center text-sm text-[var(--muted)]">Belum ada deployment.</p>;
  }

  return (
    <ul className="space-y-1">
      {deploys.map((d) => {
        const s = STATUS_STYLE[d.status] ?? STATUS_STYLE.queued;
        return (
          <li key={d.id}>
            <Link
              href={`/deploys/${d.id}`}
              className={`block rounded-lg border px-3 py-2 transition-colors ${
                d.id === activeId
                  ? "border-[var(--accent)]/50 bg-[var(--panel-2)]"
                  : "border-transparent hover:bg-[var(--panel-2)]"
              }`}
            >
              <div className="flex items-center gap-2">
                <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${s.dot}`} />
                <span className="truncate font-mono text-sm">{d.project}</span>
                <span className={`ml-auto shrink-0 text-xs ${s.text}`}>{s.label}</span>
              </div>
              <div className="mt-0.5 pl-3.5 text-xs text-[var(--muted)]">
                {d.sha && <span className="font-mono">{d.sha} · </span>}
                {formatRelative(d.created_at)}
              </div>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
