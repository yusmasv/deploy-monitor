"use client";

import { STATUS_STYLE, formatDuration } from "@/lib/format";

export interface DeployDetail {
  id: string; project: string; status: string; phase: string | null;
  started_at: number | null; ended_at: number | null; exit_code: number | null;
  sha: string | null; image: string | null; live_url: string | null;
  zip_name: string; env_keys: string; error: string | null;
}

export function DeploySummary({ d }: { d: DeployDetail }) {
  const s = STATUS_STYLE[d.status] ?? STATUS_STYLE.queued;
  const envKeys: string[] = JSON.parse(d.env_keys || "[]");
  const elapsed = d.started_at ? (d.ended_at ?? Date.now()) - d.started_at : null;

  return (
    <div className="space-y-3 rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4">
      <div className="flex items-center gap-2">
        <span className={`h-2 w-2 rounded-full ${s.dot}`} />
        <span className="font-mono text-sm">{d.project}</span>
        <span className={`text-xs ${s.text}`}>{s.label}</span>
        {elapsed !== null && (
          <span className="ml-auto text-xs text-[var(--muted)]">{formatDuration(elapsed)}</span>
        )}
      </div>

      {d.status === "success" && d.live_url && (
        <a
          href={d.live_url} target="_blank" rel="noreferrer"
          className="block truncate rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-sm text-emerald-300 hover:bg-emerald-500/10"
        >
          {d.live_url} ↗
        </a>
      )}

      {d.error && (
        <p className="rounded-lg border border-rose-500/30 bg-rose-500/5 px-3 py-2 text-sm text-rose-300">
          {d.error}
        </p>
      )}

      <dl className="space-y-1 text-xs">
        {([
          ["File", d.zip_name],
          ["Commit", d.sha],
          ["Image", d.image],
          ["Exit code", d.exit_code === null ? null : String(d.exit_code)],
          // Hanya NAMA key — nilainya memang tidak pernah disimpan (spec D7).
          ["Overridden env", envKeys.length ? envKeys.join(", ") : null],
        ] as [string, string | null][])
          .filter(([, v]) => v)
          .map(([k, v]) => (
            <div key={k} className="flex gap-2">
              <dt className="w-28 shrink-0 text-[var(--muted)]">{k}</dt>
              <dd className="truncate font-mono">{v}</dd>
            </div>
          ))}
      </dl>

      <a
        href={`/api/deploys/${d.id}/logs?plain=1`}
        className="inline-block text-xs text-[var(--muted)] underline hover:text-[var(--text)]"
      >
        Download log
      </a>
    </div>
  );
}
