"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { EnvEditor } from "./EnvEditor";
import { parseDotenv, type EnvPair } from "@/lib/envfile";

export function UploadForm() {
  const [file, setFile] = useState<File | null>(null);
  const [project, setProject] = useState("");
  const [env, setEnv] = useState<EnvPair[]>([]);
  const [paste, setPaste] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const router = useRouter();

  function pick(f: File | null) {
    setFile(f);
    if (f && !project) setProject(f.name.replace(/\.zip$/i, ""));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!file) return;
    setBusy(true);
    setError("");

    // Gabungkan baris individual dengan isi kotak paste — Import hanyalah
    // kenyamanan opsional untuk melihat/mengedit hasil parse sebelum submit,
    // BUKAN syarat. Sebelumnya, apa pun yang diketik di kotak paste tapi
    // tidak di-Import hilang diam-diam saat submit (tidak pernah masuk ke
    // FormData sama sekali) — env override yang diketik user tampak seperti
    // tidak pernah terkirim.
    const combined = [...env, ...parseDotenv(paste)];

    const body = new FormData();
    body.set("zip", file);
    body.set("project", project);
    body.set("env", JSON.stringify(combined.filter((p) => p.key.trim())));

    // setBusy(false) WAJIB di finally. Sebelumnya ia berada di baris SETELAH
    // res.json(): body respons yang bukan JSON (halaman error HTML dari Next,
    // halaman timeout dari proxy) membuat res.json() melempar, baris itu tidak
    // pernah jalan, dan form terjebak selamanya di keadaan "Mengunggah…"
    // dengan tombol mati dan tanpa satu pun pesan error — satu-satunya jalan
    // keluar adalah reload halaman.
    try {
      const res = await fetch("/api/deploys", { method: "POST", body });
      const data = await res.json().catch(() => null);

      if (!res.ok) {
        return setError(data?.error ?? "Failed to start deploy.");
      }
      if (!data?.id) {
        return setError("Failed to process server response.");
      }
      router.push(`/deploys/${data.id}`);
    } catch {
      setError("Failed to reach server.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      className="space-y-5 rounded-xl border border-[var(--border)] bg-[var(--panel)] p-5 shadow-[0_1px_0_rgba(255,255,255,0.03)_inset,0_12px_32px_-16px_rgba(0,0,0,0.6)]"
    >
      <div
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => { e.preventDefault(); setDragging(false); pick(e.dataTransfer.files[0] ?? null); }}
        className={`grid place-items-center rounded-lg border border-dashed p-10 text-center transition-all ${
          dragging
            ? "border-[var(--accent)] bg-[var(--accent)]/5"
            : "border-[var(--border)] hover:border-[var(--accent)]/40"
        }`}
      >
        <input
          id="zip" type="file" accept=".zip,application/zip"
          onChange={(e) => pick(e.target.files?.[0] ?? null)} className="hidden"
        />
        <label htmlFor="zip" className="flex cursor-pointer flex-col items-center gap-3 text-sm">
          <svg
            width="28" height="28" viewBox="0 0 24 24" fill="none"
            stroke={file ? "var(--accent)" : "var(--muted)"} strokeWidth="1.75"
            strokeLinecap="round" strokeLinejoin="round" className="transition-colors"
          >
            <path d="M12 16V4M12 4L7 9M12 4l5 5" />
            <path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
          </svg>
          {file ? (
            <span className="font-mono text-[var(--text)]">
              {file.name} <span className="text-[var(--muted)]">({(file.size / 1e6).toFixed(1)} MB)</span>
            </span>
          ) : (
            <span>
              <span className="text-[var(--accent)]">Choose a zip file</span>
              <span className="text-[var(--muted)]"> or drag it here</span>
            </span>
          )}
        </label>
      </div>

      <div className="space-y-1">
        <label className="text-sm font-medium">Project name</label>
        <input
          value={project}
          onChange={(e) => setProject(e.target.value)}
          placeholder="kanban-clone"
          className="w-full rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2.5 py-1.5 font-mono text-sm outline-none transition-colors focus:border-[var(--accent)]"
        />
        <p className="text-xs text-[var(--muted)]">
          Must match the previous deploy so existing data keeps being used.
        </p>
      </div>

      <div className="border-t border-[var(--border)] pt-5">
        <EnvEditor value={env} onChange={setEnv} paste={paste} onPasteChange={setPaste} />
      </div>

      {error && <p className="text-sm text-rose-400">{error}</p>}

      <button
        disabled={!file || !project || busy}
        className="w-full rounded-lg bg-[var(--accent)] px-3 py-2 text-sm font-medium text-white transition-colors hover:enabled:brightness-110 disabled:opacity-40"
      >
        {busy ? "Uploading…" : "Deploy"}
      </button>
    </form>
  );
}
