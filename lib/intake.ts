import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import yauzl from "yauzl";

export interface ZipLimits { maxTotalBytes: number; maxEntries: number }
export interface ExtractResult { fileCount: number; totalBytes: number; strippedWrapper: string | null }

export class ZipRejected extends Error {
  constructor(public reason: string) { super(reason); this.name = "ZipRejected"; }
}

interface Planned { path: string; buf: Buffer }

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
        return rej(new ZipRejected(`Gagal membaca entry '${e.fileName}'.`));
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
            `saat streaming entry '${name}').`,
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
        rej(new ZipRejected(`Entry '${e.fileName}' rusak.`));
      });
    });
  });
}

/** Satu-satunya penjaga terhadap zip-slip. Mengembalikan path absolut yang aman. */
function safeJoin(destDir: string, entryName: string): string {
  if (entryName.startsWith("/") || /^[a-zA-Z]:/.test(entryName)) {
    throw new ZipRejected(`Entry '${entryName}' memakai path absolut — ditolak.`);
  }
  const root = resolve(destDir);
  const full = resolve(root, entryName);
  if (full !== root && !full.startsWith(root + sep)) {
    throw new ZipRejected(`Entry '${entryName}' menunjuk keluar dari direktori tujuan — ditolak.`);
  }
  return full;
}

function topSegment(p: string): string { return p.split("/")[0]; }

export async function extractZip(
  buf: Buffer, destDir: string, limits: ZipLimits,
): Promise<ExtractResult> {
  const zf = await openZip(buf);

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
              `Entry '${name}' terlalu besar setelah di-extract (header zip menyatakan ` +
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
    planned.push({ path: safeJoin(destDir, c.name), buf: c.buf });
  }

  if (planned.length === 0) {
    throw new ZipRejected("Zip tidak berisi file apa pun yang bisa dideploy.");
  }

  // --- Fase 4: baru sekarang menulis ---
  for (const p of planned) {
    await mkdir(dirname(p.path), { recursive: true });
    await writeFile(p.path, p.buf);
  }

  return { fileCount: planned.length, totalBytes, strippedWrapper };
}
