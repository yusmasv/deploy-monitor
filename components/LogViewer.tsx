"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { parseAnsi, type LogColor } from "@/lib/ansi";
import { PhaseTimeline } from "./PhaseTimeline";
import { DeploySummary, type DeployDetail } from "./DeploySummary";

interface Line { seq: number; stream: string; text: string }

// Sama dengan TERMINAL di app/api/deploys/[id]/stream/route.ts — begitu deploy
// selesai, server menutup stream tanpa `retry:` atau status non-200, jadi
// EventSource bawaan browser tidak bisa membedakan "server menutup dengan
// sengaja" dari "koneksi putus" dan akan otomatis reconnect selamanya kalau
// tidak kita tutup sendiri di sini.
const TERMINAL = new Set(["success", "failed", "interrupted"]);

const COLOR: Record<LogColor, string> = {
  red: "var(--log-red)", green: "var(--log-green)", yellow: "var(--log-yellow)",
  blue: "var(--log-blue)", magenta: "var(--log-magenta)", cyan: "var(--log-cyan)",
};

export function LogViewer({ initial }: { initial: DeployDetail }) {
  const [deploy, setDeploy] = useState(initial);
  const [lines, setLines] = useState<Line[]>([]);
  const [filter, setFilter] = useState("");
  const [stick, setStick] = useState(true);

  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const es = new EventSource(`/api/deploys/${initial.id}/stream`);

    es.addEventListener("line", (e) => {
      const l = JSON.parse((e as MessageEvent).data) as Line;
      // Dedup: replay saat reconnect bisa tumpang tindih dengan siaran langsung.
      setLines((prev) => (prev.at(-1) && prev.at(-1)!.seq >= l.seq ? prev : [...prev, l]));
    });

    es.addEventListener("state", (e) => {
      const { deploy: d } = JSON.parse((e as MessageEvent).data) as { deploy: DeployDetail };
      if (d) setDeploy(d);
      // Deploy sudah selesai — jangan biarkan EventSource reconnect tanpa henti.
      if (d && TERMINAL.has(d.status)) es.close();
    });

    return () => es.close();
  }, [initial.id]);

  // Auto-scroll, tapi berhenti begitu user menggulir ke atas.
  useEffect(() => {
    if (!stick) return;
    const box = boxRef.current;
    if (box) box.scrollTop = box.scrollHeight;
  }, [lines, stick]);

  const shown = useMemo(
    () => (filter ? lines.filter((l) => l.text.toLowerCase().includes(filter.toLowerCase())) : lines),
    [lines, filter],
  );

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_300px]">
      <div className="order-2 min-w-0 lg:order-1">
        <div className="mb-2 flex items-center gap-2">
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Search log…"
            className="flex-1 rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1 text-xs outline-none focus:border-[var(--accent)]"
          />
          <span className="shrink-0 text-xs text-[var(--muted)]">{shown.length} lines</span>
        </div>

        <div
          ref={boxRef}
          onScroll={(e) => {
            const el = e.currentTarget;
            setStick(el.scrollHeight - el.scrollTop - el.clientHeight < 40);
          }}
          className="h-[65vh] overflow-auto rounded-xl border border-[var(--border)] bg-[#06070a] p-3 font-mono text-xs leading-relaxed"
        >
          {shown.length === 0 && (
            <p className="text-[var(--muted)]">
              {deploy.status === "queued" ? "Waiting in queue…" : "Waiting for output…"}
            </p>
          )}
          {shown.map((l) => (
            <div key={l.seq} className="whitespace-pre-wrap break-all">
              {parseAnsi(l.text).map((sp, i) => (
                <span
                  key={i}
                  style={{
                    // Banyak tool CLI (mis. `docker build`) menulis progress normal ke
                    // stderr — itu bukan tanda error. Merah HANYA untuk baris yang
                    // memang punya kode warna ANSI merah eksplisit dari script (mis.
                    // fungsi error() di deploy.sh). Baris stderr lain jatuh ke abu-abu
                    // netral, bukan otomatis merah.
                    color: sp.color ? COLOR[sp.color] : l.stream === "stderr" ? "var(--muted)" : undefined,
                    fontWeight: sp.bold ? 600 : undefined,
                  }}
                >
                  {sp.text}
                </span>
              ))}
            </div>
          ))}
        </div>

        {!stick && (
          <button
            onClick={() => setStick(true)}
            className="mt-2 rounded-md border border-[var(--border)] px-2 py-1 text-xs text-[var(--muted)] hover:text-[var(--text)]"
          >
            ↓ Follow latest log
          </button>
        )}
      </div>

      <aside className="order-1 space-y-3 lg:order-2">
        <DeploySummary d={deploy} />
        <div className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4">
          <h3 className="mb-2 text-xs font-medium text-[var(--muted)]">Stages</h3>
          <PhaseTimeline phase={deploy.phase} status={deploy.status} />
        </div>
      </aside>
    </div>
  );
}
