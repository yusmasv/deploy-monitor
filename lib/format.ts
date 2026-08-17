export function formatRelative(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s} detik lalu`;
  if (s < 3600) return `${Math.floor(s / 60)} menit lalu`;
  if (s < 86400) return `${Math.floor(s / 3600)} jam lalu`;
  return `${Math.floor(s / 86400)} hari lalu`;
}

export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}d` : `${Math.floor(s / 60)}m ${s % 60}d`;
}

export const STATUS_STYLE: Record<string, { label: string; dot: string; text: string }> = {
  queued:      { label: "Antri",    dot: "bg-slate-500",  text: "text-slate-400" },
  running:     { label: "Berjalan", dot: "bg-sky-400 animate-pulse", text: "text-sky-300" },
  success:     { label: "Sukses",   dot: "bg-emerald-400", text: "text-emerald-300" },
  failed:      { label: "Gagal",    dot: "bg-rose-500",   text: "text-rose-300" },
  interrupted: { label: "Terputus", dot: "bg-amber-400",  text: "text-amber-300" },
};
