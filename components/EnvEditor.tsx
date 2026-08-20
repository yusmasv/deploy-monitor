"use client";

import { DANGEROUS_KEYS, parseDotenv, type EnvPair } from "@/lib/envfile";

interface Props {
  value: EnvPair[];
  onChange: (v: EnvPair[]) => void;
  paste: string;
  onPasteChange: (v: string) => void;
}

export function EnvEditor({ value, onChange, paste, onPasteChange }: Props) {
  const set = (i: number, patch: Partial<EnvPair>) =>
    onChange(value.map((p, j) => (j === i ? { ...p, ...patch } : p)));

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <label className="text-sm font-medium">Environment variables</label>
        <span className="text-xs text-[var(--muted)]">
          Overwrites per key. Anything left blank is untouched.
        </span>
      </div>

      {value.length > 0 && (
        <div className="space-y-1.5">
          {value.map((pair, i) => (
            <div key={i} className="space-y-1">
              <div className="flex gap-2">
                <input
                  value={pair.key}
                  onChange={(e) => set(i, { key: e.target.value })}
                  placeholder="KEY_NAME"
                  className="w-2/5 rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1.5 font-mono text-xs outline-none transition-colors focus:border-[var(--accent)]"
                />
                <input
                  value={pair.value}
                  onChange={(e) => set(i, { value: e.target.value })}
                  placeholder="value"
                  className="flex-1 rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1.5 font-mono text-xs outline-none transition-colors focus:border-[var(--accent)]"
                />
                <button
                  type="button"
                  onClick={() => onChange(value.filter((_, j) => j !== i))}
                  className="w-7 shrink-0 rounded-md text-sm text-[var(--muted)] transition-colors hover:bg-rose-400/10 hover:text-rose-400"
                  aria-label="Remove row"
                >
                  ×
                </button>
              </div>
              {DANGEROUS_KEYS.has(pair.key.trim()) && (
                <p className="pl-1 text-xs text-amber-400">
                  {pair.key.trim() === "DATABASE_URL"
                    ? "Changing this points the app at a different database — old data stays in /srv/data but will look like it's gone."
                    : "Changing this immediately invalidates every user's login session."}
                </p>
              )}
            </div>
          ))}
        </div>
      )}

      <button
        type="button"
        onClick={() => onChange([...value, { key: "", value: "" }])}
        className="rounded-md border border-[var(--border)] px-2 py-1 text-xs text-[var(--muted)] transition-colors hover:border-[var(--accent)]/40 hover:text-[var(--text)]"
      >
        + Add
      </button>

      <details className="rounded-md text-xs text-[var(--muted)]">
        <summary className="cursor-pointer select-none transition-colors hover:text-[var(--text)]">
          Paste .env format
        </summary>
        <div className="mt-2 space-y-2">
          <textarea
            value={paste}
            onChange={(e) => onPasteChange(e.target.value)}
            rows={4}
            placeholder={"SMTP_HOST=mail.example.com\nSMTP_PASS=secret"}
            className="w-full rounded-md border border-[var(--border)] bg-[var(--panel-2)] p-2 font-mono text-xs outline-none transition-colors focus:border-[var(--accent)]"
          />
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => { onChange([...value, ...parseDotenv(paste)]); onPasteChange(""); }}
              className="rounded-md border border-[var(--border)] px-2 py-1 transition-colors hover:border-[var(--accent)]/40 hover:text-[var(--text)]"
            >
              Import into list above
            </button>
            <span>Optional — included on deploy either way.</span>
          </div>
        </div>
      </details>
    </div>
  );
}
