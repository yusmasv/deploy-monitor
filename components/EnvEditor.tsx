"use client";

import { useState } from "react";
import { DANGEROUS_KEYS, parseDotenv, type EnvPair } from "@/lib/envfile";

export function EnvEditor({ value, onChange }: { value: EnvPair[]; onChange: (v: EnvPair[]) => void }) {
  const [paste, setPaste] = useState("");

  const set = (i: number, patch: Partial<EnvPair>) =>
    onChange(value.map((p, j) => (j === i ? { ...p, ...patch } : p)));

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <label className="text-sm font-medium">Variabel environment</label>
        <span className="text-xs text-[var(--muted)]">
          Menimpa per-key. Yang tidak diisi tidak tersentuh.
        </span>
      </div>

      {value.map((pair, i) => (
        <div key={i} className="space-y-1">
          <div className="flex gap-2">
            <input
              value={pair.key}
              onChange={(e) => set(i, { key: e.target.value })}
              placeholder="NAMA_KEY"
              className="w-2/5 rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1.5 font-mono text-xs outline-none focus:border-[var(--accent)]"
            />
            <input
              value={pair.value}
              onChange={(e) => set(i, { value: e.target.value })}
              placeholder="nilai"
              className="flex-1 rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1.5 font-mono text-xs outline-none focus:border-[var(--accent)]"
            />
            <button
              type="button"
              onClick={() => onChange(value.filter((_, j) => j !== i))}
              className="px-2 text-sm text-[var(--muted)] hover:text-rose-400"
              aria-label="Hapus baris"
            >
              ×
            </button>
          </div>
          {DANGEROUS_KEYS.has(pair.key.trim()) && (
            <p className="pl-1 text-xs text-amber-400">
              {pair.key.trim() === "DATABASE_URL"
                ? "Mengubah ini mengarahkan app ke database lain — data lama tetap di /srv/data dan akan terlihat seperti hilang."
                : "Mengubah ini membuat semua sesi login pengguna langsung tidak berlaku."}
            </p>
          )}
        </div>
      ))}

      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => onChange([...value, { key: "", value: "" }])}
          className="rounded-md border border-[var(--border)] px-2 py-1 text-xs text-[var(--muted)] hover:text-[var(--text)]"
        >
          + Tambah
        </button>
      </div>

      <details className="text-xs text-[var(--muted)]">
        <summary className="cursor-pointer select-none">Tempel format .env</summary>
        <textarea
          value={paste}
          onChange={(e) => setPaste(e.target.value)}
          rows={4}
          placeholder={"SMTP_HOST=mail.contoh.com\nSMTP_PASS=rahasia"}
          className="mt-2 w-full rounded-md border border-[var(--border)] bg-[var(--panel-2)] p-2 font-mono text-xs outline-none focus:border-[var(--accent)]"
        />
        <button
          type="button"
          onClick={() => { onChange([...value, ...parseDotenv(paste)]); setPaste(""); }}
          className="mt-1 rounded-md border border-[var(--border)] px-2 py-1 hover:text-[var(--text)]"
        >
          Impor
        </button>
      </details>
    </div>
  );
}
