import { mkdir, writeFile, rename, rm } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import yauzl from "yauzl";

export interface ZipLimits { maxTotalBytes: number; maxEntries: number }
export interface ExtractResult { fileCount: number; totalBytes: number; strippedWrapper: string | null }

export class ZipRejected extends Error {
  constructor(public reason: string) { super(reason); this.name = "ZipRejected"; }
}

interface Planned { relPath: string; finalPath: string; buf: Buffer }

/**
 * Bungkus nama entry (asal dari zip, sepenuhnya dikendalikan penyerang)
 * sebelum masuk ke pesan error mana pun. Pesan-pesan ini adalah "reason"
 * yang dilihat pengguna DAN mengalir ke log viewer aplikasi ini — kalau
 * nama entry mengandung newline, itu bisa memalsukan baris log
 * (mis. entry bernama `x\n[ERROR] deploy sukses\n`). JSON.stringify
 * meng-escape newline, tanda kutip, dan karakter kontrol lainnya sekaligus.
 */
function escapeForMessage(name: string): string {
  return JSON.stringify(name);
}

function openZip(buf: Buffer): Promise<yauzl.ZipFile> {
  return new Promise((res, rej) =>
    // decodeStrings:false DISENGAJA. Dengan default (true), yauzl menjalankan
    // validateFileName sendiri dan menolak segmen '..' serta path absolut
    // SEBELUM event 'entry' sampai ke sini — sehingga safeJoin() tidak pernah
    // terpanggil untuk kasus yang justru paling penting, dan test keamanan di
    // bawah malah menguji perilaku library, bukan kode kita. Batas keamanan
    // harus milik kita sendiri supaya bisa diuji langsung. Konsekuensinya
    // fileName datang sebagai Buffer dan kita decode sendiri.
    yauzl.fromBuffer(buf, { lazyEntries: true, decodeStrings: false }, (err, zf) =>
      err || !zf ? rej(new ZipRejected("File yang diunggah bukan file zip yang valid.")) : res(zf),
    ),
  );
}

/**
 * Membaca satu entry sampai selesai, sambil menjaga anggaran byte APLIKASI
 * (bukan sekadar percaya ukuran yang diumumkan zip). `remainingBudget` adalah
 * sisa `maxTotalBytes` sebelum entry ini dibaca. Kalau bytes yang benar-benar
 * mengalir keluar dari decompressor melebihi sisa anggaran, stream dihentikan
 * SAAT ITU JUGA — tidak menunggu entry selesai — supaya entry yang header-nya
 * bohong (declare kecil, decompress raksasa) tidak sempat menghabiskan memori
 * sebelum ketahuan. Ini lapis kedua yang independen dari pengecekan
 * `uncompressedSize` di pemanggil: milik APLIKASI ini sendiri, bukan sekadar
 * mempercayai penegakan internal yauzl (lihat catatan di extractZip).
 */
function readEntry(
  zf: yauzl.ZipFile, e: yauzl.Entry, name: string, remainingBudget: number, maxTotalBytes: number,
): Promise<Buffer> {
  return new Promise((res, rej) => {
    let settled = false;
    zf.openReadStream(e, (err, rs) => {
      if (err || !rs) {
        settled = true;
        return rej(new ZipRejected(`Gagal membaca entry ${escapeForMessage(name)}.`));
      }
      const chunks: Buffer[] = [];
      let size = 0;
      rs.on("data", (c: Buffer) => {
        if (settled) return;
        size += c.length;
        if (size > remainingBudget) {
          settled = true;
          rs.destroy();
          rej(new ZipRejected(
            `Isi zip terlalu besar setelah di-extract (melebihi batas ${maxTotalBytes} byte ` +
            `saat streaming entry ${escapeForMessage(name)}).`,
          ));
          return;
        }
        chunks.push(c);
      });
      rs.on("end", () => {
        if (settled) return;
        settled = true;
        res(Buffer.concat(chunks));
      });
      rs.on("error", () => {
        if (settled) return;
        settled = true;
        rej(new ZipRejected(`Entry ${escapeForMessage(name)} rusak.`));
      });
    });
  });
}

/** Satu-satunya penjaga terhadap zip-slip. Mengembalikan path absolut yang aman. */
function safeJoin(destDir: string, entryName: string): string {
  if (entryName.startsWith("/") || /^[a-zA-Z]:/.test(entryName)) {
    throw new ZipRejected(`Entry ${escapeForMessage(entryName)} memakai path absolut — ditolak.`);
  }
  const root = resolve(destDir);
  const full = resolve(root, entryName);
  // '.', '' dan 'a/..' semuanya me-resolve ke destDir itu sendiri. Tidak ada
  // entry FILE yang sah bisa menghasilkan ini — kalau lolos sampai Fase 4,
  // writeFile(destDir, ...) gagal dengan EISDIR dan pesannya bukan ZipRejected
  // (bahasa Inggris, salah diklasifikasikan sebagai fault internal). Matikan
  // di sini, di Fase 1, bukan sebagai error filesystem nanti.
  if (full === root) {
    throw new ZipRejected(
      `Entry ${escapeForMessage(entryName)} me-resolve ke direktori tujuan itu sendiri — bukan path file yang valid, ditolak.`,
    );
  }
  if (!full.startsWith(root + sep)) {
    throw new ZipRejected(`Entry ${escapeForMessage(entryName)} menunjuk keluar dari direktori tujuan — ditolak.`);
  }
  return full;
}

/**
 * Nama yang mengandung byte kontrol (termasuk NUL) bukan nama file yang
 * valid: fs.writeFile/mkdir melempar TypeError (ERR_INVALID_ARG_VALUE),
 * bukan error zip yang bisa kita tangani rapi sebagai ZipRejected — dan
 * newline di nama adalah vektor pemalsuan log (lihat escapeForMessage).
 * Ditolak di sini, di Fase 1, sebelum entry sempat direncanakan untuk ditulis.
 */
function assertWritableName(name: string): void {
  if (/[\x00-\x1f]/.test(name)) {
    throw new ZipRejected(
      `Entry ${escapeForMessage(name)} mengandung karakter kontrol pada namanya — ditolak.`,
    );
  }
}

function topSegment(p: string): string { return p.split("/")[0]; }

/**
 * Fase 3 sudah membangun daftar `planned` lengkap sebelum ada yang ditulis,
 * jadi tabrakan file/direktori bisa dideteksi secara PASTI di sini — bukan
 * ditebak — sebelum Fase 4 mulai menulis. Kasusnya: satu entry adalah file
 * di path X, entry lain butuh X sebagai direktori induknya (mis. "a.txt"
 * lalu "a.txt/b"). Kalau lolos ke Fase 4, mkdir(X) gagal EEXIST dan entry
 * sebelumnya sudah keburu tertulis.
 */
function detectPathCollision(planned: Planned[], root: string): void {
  const filePaths = new Set(planned.map((p) => p.finalPath));
  const neededDirs = new Set<string>();
  for (const p of planned) {
    let dir = dirname(p.finalPath);
    while (dir !== root && !neededDirs.has(dir)) {
      neededDirs.add(dir);
      dir = dirname(dir);
    }
  }
  for (const dir of neededDirs) {
    if (filePaths.has(dir)) {
      throw new ZipRejected(
        `Zip berisi entry yang saling bertabrakan: ${escapeForMessage(relative(root, dir))} ` +
        `dibutuhkan sebagai direktori oleh satu entry, tapi entry lain menjadikannya file — ditolak.`,
      );
    }
  }
}

export async function extractZip(
  buf: Buffer, destDir: string, limits: ZipLimits,
): Promise<ExtractResult> {
  const zf = await openZip(buf);
  const root = resolve(destDir);

  // --- Fase 1: baca & validasi SEMUANYA di memori. Belum ada yang ditulis. ---
  const collected: { name: string; buf: Buffer }[] = [];
  let totalBytes = 0;

  await new Promise<void>((res, rej) => {
    zf.on("entry", (e: yauzl.Entry) => {
      void (async () => {
        try {
          // decodeStrings:false -> fileName adalah Buffer, bukan string.
          const rawName = Buffer.isBuffer(e.fileName)
            ? e.fileName.toString("utf8")
            : String(e.fileName);
          const name = rawName.replace(/\\/g, "/");   // path gaya Windows
          if (name.endsWith("/")) return zf.readEntry();          // direktori: lewati

          assertWritableName(name);                                // lempar kalau bukan nama file yang valid
          safeJoin(destDir, name);                                 // lempar kalau tidak aman

          if (collected.length + 1 > limits.maxEntries) {
            throw new ZipRejected(`Zip berisi terlalu banyak entry (batas ${limits.maxEntries}).`);
          }

          // Lapis 1 (murah, cegah dini): tolak berdasar ukuran yang DIUMUMKAN
          // di central directory zip — SEBELUM entry dibongkar sama sekali.
          // Menutup celah "zip bomb" untuk entry yang jujur soal ukurannya
          // tapi sendirian (atau bersama entry sebelumnya) sudah melebihi
          // sisa anggaran ekstraksi. `entry.uncompressedSize` dibaca yauzl
          // dari central directory saat zip dibuka, jadi tersedia di sini
          // tanpa perlu membongkar apa pun.
          const remaining = limits.maxTotalBytes - totalBytes;
          if (e.uncompressedSize > remaining) {
            throw new ZipRejected(
              `Entry ${escapeForMessage(name)} terlalu besar setelah di-extract (header zip menyatakan ` +
              `${e.uncompressedSize} byte, sisa batas ${remaining} byte) — ditolak sebelum entry dibongkar.`,
            );
          }

          // Lapis 2 (defense-in-depth, saat streaming): lihat komentar di
          // readEntry(). Ini BUKAN dead code meskipun di yauzl 3.4.0 lapis
          // ini nyaris tidak pernah jadi yang pertama menolak: yauzl sendiri
          // sudah mencegat header yang bohong lewat AssertByteCountStream
          // internalnya (node_modules/yauzl/index.js) — tapi itu detail
          // implementasi INTERNAL, tidak disebut sekali pun di README-nya,
          // jadi tidak ada jaminan API bahwa itu tetap ada di versi yauzl
          // berikutnya. Lapis ini adalah asuransi untuk yauzl versi MASA
          // DEPAN, bukan untuk yauzl 3.4.0 sekarang. Alasan yang sama:
          // test "under-declares" di intake.test.ts sengaja menguji
          // rejection secara generik, bukan pesan spesifik Lapis 2 —
          // karena saat ini yauzl yang menolak duluan, bukan kode ini.
          const data = await readEntry(zf, e, name, remaining, limits.maxTotalBytes);
          totalBytes += data.length;
          if (totalBytes > limits.maxTotalBytes) {
            throw new ZipRejected(
              `Isi zip terlalu besar setelah di-extract (batas ${limits.maxTotalBytes} byte).`,
            );
          }
          collected.push({ name, buf: data });
          zf.readEntry();
        } catch (err) { rej(err); }
      })();
    });
    zf.on("end", () => res());
    zf.on("error", () => rej(new ZipRejected("File yang diunggah bukan file zip yang valid.")));
    zf.readEntry();
  });

  // --- Fase 2: lepas direktori pembungkus tunggal ---
  // .git tidak boleh dianggap sebagai kandidat pembungkus — kalau satu-satunya
  // entry top-level kebetulan ".git", itu bukan wrapper project, dan harus
  // tetap ketahuan sebagai .git supaya Fase 3 bisa membuangnya.
  const nonGit = collected.filter((c) => c.name !== ".git" && !c.name.startsWith(".git/"));
  const tops = new Set(nonGit.map((c) => topSegment(c.name)));
  const hasRootFile = nonGit.some((c) => !c.name.includes("/"));
  let strippedWrapper: string | null = null;

  if (nonGit.length > 0 && tops.size === 1 && !hasRootFile) {
    strippedWrapper = [...tops][0];
    const prefix = strippedWrapper + "/";
    for (const c of collected) {
      if (c.name.startsWith(prefix)) c.name = c.name.slice(prefix.length);
    }
  }

  // --- Fase 3: buang .git (staging repo punya .git-nya sendiri) ---
  const planned: Planned[] = [];
  for (const c of collected) {
    if (c.name === ".git" || c.name.startsWith(".git/")) continue;
    const finalPath = safeJoin(destDir, c.name);
    planned.push({ relPath: relative(root, finalPath), finalPath, buf: c.buf });
  }

  if (planned.length === 0) {
    throw new ZipRejected("Zip tidak berisi file apa pun yang bisa dideploy.");
  }

  // Tabrakan file/direktori: pasti terdeteksi sekarang, dari daftar planned
  // yang sudah lengkap — bukan ditemukan nanti sebagai EEXIST di tengah
  // menulis dengan sebagian entry sebelumnya sudah tertulis.
  detectPathCollision(planned, root);

  // --- Fase 4: baru sekarang menulis — semua-atau-tidak-sama-sekali ---
  // Setiap entry ditulis dulu ke direktori staging DI DALAM destDir (jadi
  // dijamin satu filesystem yang sama dengan tujuan akhir, supaya rename()
  // di bawah murah & tidak butuh ruang disk baru), baru dipindah dengan
  // rename() ke lokasi akhirnya. destDir sendiri tidak tersentuh sampai
  // SEMUA entry selesai ditulis ke staging. Kalau penulisan ke staging gagal
  // di tengah jalan (mis. ENOSPC — disk penuh di host ini pernah benar-benar
  // terjadi di sesi pengerjaan task ini), destDir belum pernah disentuh sama
  // sekali dan `finally` di bawah membuang staging beserta isinya. Kalau
  // justru proses PEMINDAHAN (rename) yang gagal di tengah jalan, entry yang
  // SUDAH terlanjur pindah ke destDir di-rollback (dihapus) di blok catch,
  // supaya tidak ada sisa entry ke-1..ke-(n-1) yang tertinggal.
  const stagingDir = join(destDir, `.zip-extract-${randomUUID()}`);
  await mkdir(stagingDir, { recursive: true });
  const movedFinalPaths: string[] = [];
  // Direktori yang BARU DIBUAT untuk lokasi akhir suatu entry — dicatat
  // SAAT mkdir berhasil membuatnya, BUKAN setelah rename entry itu sukses.
  // fs.mkdir(dir, {recursive:true}) mengembalikan direktori PERTAMA yang
  // benar-benar ia buat (atau undefined kalau tidak ada yang baru dibuat —
  // diverifikasi langsung). Kalau dicatat baru SETELAH rename sukses (versi
  // sebelumnya), ada jendela: mkdir membuat direktori baru, lalu rename
  // gagal — direktori itu tidak pernah tercatat di mana pun dan rollback
  // tidak pernah membuang direktori kosong bekasnya. Mencatat di titik mkdir
  // sendiri menutup jendela itu, dan sekalian membuat pembersihan cukup satu
  // rm({recursive:true}) per chain — tidak perlu lagi menyusuri leluhur
  // direktori satu-satu pakai rmdir seperti versi sebelumnya.
  const createdDirs: string[] = [];
  try {
    for (const p of planned) {
      const stagingPath = join(stagingDir, p.relPath);
      await mkdir(dirname(stagingPath), { recursive: true });
      await writeFile(stagingPath, p.buf);
    }
    for (const p of planned) {
      const stagingPath = join(stagingDir, p.relPath);
      const createdRoot = await mkdir(dirname(p.finalPath), { recursive: true });
      if (createdRoot) createdDirs.push(createdRoot);
      await rename(stagingPath, p.finalPath);
      movedFinalPaths.push(p.finalPath);
    }
  } catch (err) {
    // Rollback: buang direktori yang BARU DIBUAT untuk commit ini (sekali
    // rm recursive per chain — otomatis membuang file apa pun yang sempat
    // dipindah ke dalamnya juga), lalu buang file yang sempat pindah ke
    // direktori yang SUDAH ADA sebelumnya (mis. langsung di root destDir,
    // yang mkdir tidak pernah "buat" sehingga tidak masuk createdDirs).
    // rm({force:true}) aman dipanggil dua kali untuk path yang sama — kalau
    // sudah hilang lewat pembersihan createdDirs, ini jadi no-op. Ini BUKAN
    // masalah zip (validasi di Fase 1-3 sudah lolos) — jadi error asli
    // (mis. ENOSPC dari Node) dilempar ulang apa adanya, tidak dibungkus
    // jadi ZipRejected.
    for (const dir of createdDirs) {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
    for (const finalPath of movedFinalPaths) {
      await rm(finalPath, { force: true }).catch(() => {});
    }
    throw err;
  } finally {
    await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
  }

  return { fileCount: planned.length, totalBytes, strippedWrapper };
}
