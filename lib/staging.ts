import { mkdtemp, mkdir, rm, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, resolve, sep } from "node:path";
import { extractZip, type ExtractResult, type ZipLimits } from "./intake";
import { normalizeProject } from "./project";

// Diawali huruf besar dengan sengaja: normalizeProject() SELALU me-lowercase
// sebelum memfilter karakter (lib/project.ts), jadi tidak ada nama project
// yang bisa menghasilkan string ini — direktori staging sementara tidak akan
// pernah bentrok dengan direktori project manapun.
const STAGING_PREFIX = ".Staging-";

export interface PrepareOpts {
  project: string;
  zip: Buffer;
  uploadsDir: string;
  limits: ZipLimits;
}

export async function prepareStaging(
  opts: PrepareOpts,
): Promise<{ dir: string; extract: ExtractResult }> {
  // normalizeProject sudah terbukti idempoten (Task 2): nama yang pemanggil
  // (mis. API route) sudah normalkan lolos di sini tanpa berubah, jadi
  // memanggilnya lagi tidak merusak apa pun untuk jalur yang sudah benar.
  // Tapi prepareStaging TIDAK BOLEH mempercayai pemanggil melakukan itu:
  // Runner meneruskan job.project apa adanya, dan satu pemanggil masa depan
  // yang lupa memanggil normalizeProject akan membuat kita menulis file di
  // sembarang tempat di host — SEBAGAI ROOT.
  const project = normalizeProject(opts.project);
  const dir = join(opts.uploadsDir, project);

  // Lapis kedua, independen dari aturan normalisasi nama: pastikan LANGSUNG
  // bahwa path yang di-resolve benar-benar di dalam uploadsDir, alih-alih
  // menyimpulkannya dari aturan nama semata. Sama seperti safeJoin() di
  // lib/intake.ts. Ini jaring pengaman kalau aturan normalisasi nama di atas
  // suatu saat dilonggarkan dan mulai meloloskan '/'.
  const root = resolve(opts.uploadsDir);
  const resolvedDir = resolve(dir);
  if (resolvedDir === root || !resolvedDir.startsWith(root + sep)) {
    throw new Error(
      `Nama project '${opts.project}' menghasilkan path di luar direktori uploads — ditolak.`,
    );
  }

  // Staging dibuat DI DALAM uploadsDir (bukan os.tmpdir()) supaya berada di
  // filesystem yang SAMA — rename() di bawah cuma atomic kalau sumber dan
  // tujuan satu filesystem; lintas filesystem rename gagal (EXDEV).
  await mkdir(opts.uploadsDir, { recursive: true });
  const staged = await mkdtemp(join(opts.uploadsDir, STAGING_PREFIX));

  let extract: ExtractResult;
  try {
    // Validasi + tulis semuanya ke `staged` dulu. Zip yang ditolak tidak
    // boleh menyentuh upload sebelumnya yang baik-baik saja di `dir`.
    extract = await extractZip(opts.zip, staged, opts.limits);

    // Tukar isi `dir` lewat DUA rename atomic, bukan hapus-lalu-salin: di
    // setiap titik yang bisa diamati, `dir` selalu berisi upload lama UTUH
    // atau upload baru UTUH — tidak pernah setengah-terhapus atau
    // setengah-tertulis. Beda dari desain lama (staging git repo): sekarang
    // `dir` adalah working copy yang langsung dibaca deploy.sh, jadi
    // ketidakkonsistenan working tree tidak lagi "tidak masalah karena cuma
    // commit yang dibaca" — harus benar-benar atomic.
    //
    // Satu-satunya jendela yang tidak atomic: proses mati PERSIS di antara
    // kedua rename di bawah. Akibatnya `dir` sesaat tidak ada sama sekali —
    // bukan korupsi (isi lama ATAU baru, tidak pernah campuran) — dan upload
    // berikutnya membuatnya lagi dari nol seperti biasa.
    const orphan = `${dir}.orphan-${randomUUID()}`;
    if (existsSync(dir)) {
      await rename(dir, orphan);
    }
    await rename(staged, dir);
    await rm(orphan, { recursive: true, force: true }).catch(() => {});
  } finally {
    // Kalau rename di atas sudah berhasil, `staged` sudah pindah ke `dir`
    // dan path ini tidak ada lagi — rm dengan force:true diam-diam no-op.
    await rm(staged, { recursive: true, force: true }).catch(() => {});
  }

  return { dir, extract };
}
