import { requireAuth } from "@/lib/auth";
import { getServer } from "@/lib/server";
import { normalizeProject } from "@/lib/project";
import { validateEnv, EnvInvalid, type EnvPair } from "@/lib/envfile";
import { sanitizeUploadName } from "@/lib/intake";

export const dynamic = "force-dynamic";

export async function GET() {
  const denied = await requireAuth();
  if (denied) return denied;
  return Response.json({ deploys: getServer().db.listDeploys(50) });
}

// Ruang untuk field form lain (project, env JSON) di luar file zip itu sendiri.
// Beberapa KB cukup longgar untuk itu, tapi tetap membatasi ledakan RAM sebelum
// req.formData() selesai membaca seluruh body ke memori.
const FORM_OVERHEAD_BYTES = 64 * 1024;

export async function POST(req: Request) {
  const denied = await requireAuth();
  if (denied) return denied;

  const { runner, cfg } = getServer();

  // req.formData() membaca SELURUH body multipart ke RAM sebelum baris kode
  // manapun di bawah ini sempat jalan — App Router tidak punya batas ukuran
  // body bawaan (beda dari Pages Router). Proses ini berjalan dengan
  // OOMScoreAdjust=-500, jadi kalau host kehabisan memori, KERNEL akan
  // membunuh proses LAIN dulu untuk melindungi proses ini — upload raksasa
  // di sini bisa menjatuhkan layanan lain di host yang sama. Cek
  // Content-Length ini adalah fast-path SEBELUM buffering terjadi; cek
  // file.size di bawah tetap wajib karena Content-Length bisa hilang atau
  // dibohongi klien.
  const contentLength = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(contentLength) && contentLength > cfg.maxZipBytes + FORM_OVERHEAD_BYTES) {
    return Response.json(
      { error: `Body terlalu besar (${contentLength} byte, batas ${cfg.maxZipBytes}).` },
      { status: 413 },
    );
  }

  const form = await req.formData();

  const file = form.get("zip");
  if (!(file instanceof File)) {
    return Response.json({ error: "File zip wajib diunggah." }, { status: 400 });
  }
  if (file.size > cfg.maxZipBytes) {
    return Response.json(
      { error: `Zip terlalu besar (${file.size} byte, batas ${cfg.maxZipBytes}).` },
      { status: 400 },
    );
  }

  let project: string;
  try {
    project = normalizeProject(String(form.get("project") ?? ""));
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }

  let env: EnvPair[];
  try {
    env = validateEnv(JSON.parse(String(form.get("env") ?? "[]")) as EnvPair[]);
  } catch (e) {
    // EnvInvalid tidak pernah memuat nilai — aman dikirim ke klien.
    const message = e instanceof EnvInvalid ? e.message : "Format env tidak valid.";
    return Response.json({ error: message }, { status: 400 });
  }

  const id = await runner.enqueue({
    project,
    zip: Buffer.from(await file.arrayBuffer()),
    // file.name adalah input mentah operator dan mengalir apa adanya ke log
    // deploy (Runner.execute) — tanpa sanitasi ini karakter kontrol (ESC,
    // newline) di nama file bisa memalsukan baris log. Sama seperti
    // normalizeProject() untuk nama project dan KEY_RE untuk nama env key.
    zipName: sanitizeUploadName(file.name),
    env,
  });

  return Response.json({ id, project }, { status: 202 });
}
