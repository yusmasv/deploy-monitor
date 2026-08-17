"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { EnvEditor } from "./EnvEditor";
import type { EnvPair } from "@/lib/envfile";

export function UploadForm() {
  const [file, setFile] = useState<File | null>(null);
  const [project, setProject] = useState("");
  const [env, setEnv] = useState<EnvPair[]>([]);
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

    const body = new FormData();
    body.set("zip", file);
    body.set("project", project);
    body.set("env", JSON.stringify(env.filter((p) => p.key.trim())));

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
        return setError(data?.error ?? "Gagal memulai deploy.");
      }
      if (!data?.id) {
        return setError("Gagal memproses respons server.");
      }
      router.push(`/deploys/${data.id}`);
    } catch {
      setError("Gagal menghubungi server.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4 rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4">
      <div
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => { e.preventDefault(); setDragging(false); pick(e.dataTransfer.files[0] ?? null); }}
        className={`grid place-items-center rounded-lg border border-dashed p-6 text-center transition-colors ${
          dragging ? "border-[var(--accent)] bg-[var(--accent)]/5" : "border-[var(--border)]"
        }`}
      >
        <input
          id="zip" type="file" accept=".zip,application/zip"
          onChange={(e) => pick(e.target.files?.[0] ?? null)} className="hidden"
        />
        <label htmlFor="zip" className="cursor-pointer text-sm">
          {file ? (
            <span className="font-mono text-[var(--text)]">
              {file.name} <span className="text-[var(--muted)]">({(file.size / 1e6).toFixed(1)} MB)</span>
            </span>
          ) : (
            <>
              <span className="text-[var(--accent)]">Pilih file zip</span>
              <span className="text-[var(--muted)]"> atau seret ke sini</span>
            </>
          )}
        </label>
      </div>

      <div>
        <label className="text-sm font-medium">Nama project</label>
        <input
          value={project}
          onChange={(e) => setProject(e.target.value)}
          placeholder="kanban-clone"
          className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1.5 font-mono text-sm outline-none focus:border-[var(--accent)]"
        />
        <p className="mt-1 text-xs text-[var(--muted)]">
          Harus sama dengan deploy sebelumnya agar data lama tetap terpakai.
        </p>
      </div>

      <EnvEditor value={env} onChange={setEnv} />

      {error && <p className="text-sm text-rose-400">{error}</p>}

      <button
        disabled={!file || !project || busy}
        className="w-full rounded-lg bg-[var(--accent)] px-3 py-2 text-sm font-medium text-white disabled:opacity-40"
      >
        {busy ? "Mengunggah…" : "Deploy"}
      </button>
    </form>
  );
}
