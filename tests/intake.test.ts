import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractZip, sanitizeUploadName, ZipRejected } from "../lib/intake";
import { makeZip } from "./helpers/zip";

const LIMITS = { maxTotalBytes: 1024 * 1024, maxEntries: 100 };
let dest: string;

beforeEach(async () => { dest = await mkdtemp(join(tmpdir(), "intake-")); });
afterEach(async () => { await rm(dest, { recursive: true, force: true }); });

describe("extractZip — keamanan", () => {
  it("menolak zip-slip lewat ../", async () => {
    const zip = makeZip([{ name: "../pwned.txt", data: Buffer.from("x") }]);
    await expect(extractZip(zip, dest, LIMITS)).rejects.toThrow(/keluar dari direktori/i);
  });

  it("menolak ../ yang tersembunyi di tengah path", async () => {
    const zip = makeZip([{ name: "a/b/../../../pwned.txt", data: Buffer.from("x") }]);
    await expect(extractZip(zip, dest, LIMITS)).rejects.toThrow(/keluar dari direktori/i);
  });

  it("menolak traversal gaya Windows (backslash) sama seperti ../", async () => {
    // lib/intake.ts menormalkan `\` jadi `/` SEBELUM safeJoin dipanggil.
    // Transform itu sendiri adalah bagian dari batas keamanan: tanpanya
    // `..\..\pwned.txt` tidak mengandung satu pun `/` sehingga resolve()
    // memperlakukannya sebagai satu nama file biasa dan zip-slip lolos.
    const zip = makeZip([{ name: "..\\..\\pwned.txt", data: Buffer.from("x") }]);
    await expect(extractZip(zip, dest, LIMITS)).rejects.toThrow(/keluar dari direktori/i);
    expect(await readdir(dest)).toEqual([]);
  });

  it("menolak path absolut", async () => {
    const zip = makeZip([{ name: "/etc/cron.d/pwned", data: Buffer.from("x") }]);
    await expect(extractZip(zip, dest, LIMITS)).rejects.toThrow(/absolut/i);
  });

  it("menolak SEBELUM menulis file apa pun", async () => {
    const zip = makeZip([
      { name: "aman.txt", data: Buffer.from("ok") },
      { name: "../pwned.txt", data: Buffer.from("x") },
    ]);
    await expect(extractZip(zip, dest, LIMITS)).rejects.toThrow();
    expect(await readdir(dest)).toEqual([]);   // tidak ada yang tertulis sama sekali
  });

  it("menolak zip yang melebihi batas ukuran hasil extract", async () => {
    const zip = makeZip([{ name: "besar.bin", data: Buffer.alloc(5000, 0) }]);
    await expect(extractZip(zip, dest, { maxTotalBytes: 1000, maxEntries: 100 }))
      .rejects.toThrow(/terlalu besar/i);
  });

  it("menolak entry berdasar ukuran yang diumumkan header — sebelum dibongkar", async () => {
    // Header zip jujur (declaredSize == data.length asli), tapi angkanya
    // sendiri sudah melebihi sisa anggaran. Ini harus ketahuan dari
    // uncompressedSize di central directory saja, TANPA membongkar entry.
    const zip = makeZip([{ name: "besar.bin", data: Buffer.alloc(5000, 0) }]);
    await expect(extractZip(zip, dest, { maxTotalBytes: 1000, maxEntries: 100 }))
      .rejects.toThrow(/sebelum entry dibongkar/i);
  });

  it("tetap menolak zip walau entry berbohong soal ukurannya di header (under-declared)", async () => {
    // Header MENGAKU cuma 10 byte tapi datanya sungguhan 50.000 byte —
    // memalsukan uncompressedSize seperti trik zip-bomb klasik. Lapis
    // pre-check kita percaya header (10 <= sisa anggaran), jadi lolos di
    // situ; yang menggagalkannya adalah pengecekan konsistensi byte saat
    // streaming (baik milik aplikasi ini maupun milik yauzl sendiri — lihat
    // catatan di lib/intake.ts). Yang penting bagi test ini: hasil akhirnya
    // zip tetap DITOLAK, bukan lolos ditulis ke disk dengan ukuran nyata
    // yang tidak pernah diperiksa.
    const real = Buffer.alloc(50_000, 7);
    const zip = makeZip([{ name: "liar.bin", data: real, declaredSize: 10 }]);
    await expect(extractZip(zip, dest, { maxTotalBytes: 1000, maxEntries: 100 }))
      .rejects.toThrow();
    expect(await readdir(dest)).toEqual([]);
  });

  it("menolak akumulasi banyak entry yang masing-masing kecil tapi totalnya melebihi anggaran", async () => {
    // Tidak ada satu pun entry di sini yang mencurigakan kalau dilihat
    // sendiri-sendiri: 400 byte, jauh di bawah batas 1000. Yang melanggar
    // adalah TOTALNYA (1600). Ini menguji bahwa anggaran benar-benar
    // AKUMULATIF lintas entry — `remaining` menyusut mengikuti `totalBytes`
    // yang sudah terpakai — bukan dicek per entry secara terpisah.
    const zip = makeZip(
      Array.from({ length: 4 }, (_, i) => ({ name: `f${i}.bin`, data: Buffer.alloc(400, i) })),
    );
    await expect(extractZip(zip, dest, { maxTotalBytes: 1000, maxEntries: 100 }))
      .rejects.toThrow(/terlalu besar/i);
    expect(await readdir(dest)).toEqual([]);
  });

  it("menolak akumulasi entry yang ukuran nyatanya melebihi anggaran walau header tiap entry mengaku kecil", async () => {
    // Varian yang sama, tapi tiap header BERBOHONG mengaku 10 byte — jadi
    // pre-check berbasis `uncompressedSize` tidak pernah menaruh curiga pada
    // satu entry pun. Yang harus menahan di sini adalah penghitungan byte
    // NYATA saat streaming. Seperti test "under-declared" di atas, test ini
    // sengaja menguji HASIL AKHIRNYA secara generik (ditolak, tidak ada yang
    // tertulis) dan bukan pesan lapis tertentu: mana dari ketiga lapis
    // (pre-check header, budget saat streaming, cek total setelah baca) yang
    // menembak duluan adalah detail implementasi — termasuk milik yauzl.
    const zip = makeZip(
      Array.from({ length: 4 }, (_, i) => ({
        name: `f${i}.bin`, data: Buffer.alloc(400, i), declaredSize: 10,
      })),
    );
    await expect(extractZip(zip, dest, { maxTotalBytes: 1000, maxEntries: 100 })).rejects.toThrow();
    expect(await readdir(dest)).toEqual([]);
  });

  it("menolak zip dengan entry terlalu banyak", async () => {
    const zip = makeZip(Array.from({ length: 10 }, (_, i) => ({ name: `f${i}.txt` })));
    await expect(extractZip(zip, dest, { maxTotalBytes: 1e6, maxEntries: 5 }))
      .rejects.toThrow(/terlalu banyak/i);
  });

  it("menolak data yang bukan zip", async () => {
    await expect(extractZip(Buffer.from("ini bukan zip"), dest, LIMITS))
      .rejects.toThrow(/bukan file zip/i);
  });
});

describe("extractZip — keamanan tulis-ke-disk", () => {
  // Reproducer 1: nama yang me-resolve ke destDir itu sendiri. Sebelum
  // fix, safeJoin sengaja MENGIZINKAN full === root, jadi entry ini lolos
  // Fase 1-3 dan baru meledak di Fase 4 sebagai writeFile(destDir, ...) ->
  // EISDIR (bukan ZipRejected, bahasa Inggris) — dengan "aman.txt" (entry
  // sebelumnya) sudah keburu tertulis ke disk.
  it("menolak entry '.' SEBELUM menulis apa pun (bukan EISDIR di Fase 4)", async () => {
    const zip = makeZip([
      { name: "aman.txt", data: Buffer.from("ok") },
      { name: ".", data: Buffer.from("x") },
    ]);
    await expect(extractZip(zip, dest, LIMITS)).rejects.toBeInstanceOf(ZipRejected);
    expect(await readdir(dest)).toEqual([]);
  });

  it("menolak entry dengan nama kosong ('') — juga me-resolve ke destDir itu sendiri", async () => {
    const zip = makeZip([{ name: "", data: Buffer.from("x") }]);
    await expect(extractZip(zip, dest, LIMITS)).rejects.toBeInstanceOf(ZipRejected);
    expect(await readdir(dest)).toEqual([]);
  });

  it("menolak entry 'a/..' — juga me-resolve ke destDir itu sendiri", async () => {
    const zip = makeZip([{ name: "a/..", data: Buffer.from("x") }]);
    await expect(extractZip(zip, dest, LIMITS)).rejects.toBeInstanceOf(ZipRejected);
    expect(await readdir(dest)).toEqual([]);
  });

  // Reproducer 2: satu entry adalah file di path X, entry lain butuh X
  // sebagai direktori induknya. Sebelum fix, ini baru ketahuan di Fase 4
  // sebagai mkdir(X) -> EEXIST, dengan "a.txt" sudah keburu tertulis.
  it("menolak SEBELUM menulis kalau ada tabrakan file/direktori (a.txt lalu a.txt/b)", async () => {
    const zip = makeZip([
      { name: "a.txt", data: Buffer.from("x") },
      { name: "a.txt/b", data: Buffer.from("y") },
    ]);
    await expect(extractZip(zip, dest, LIMITS)).rejects.toBeInstanceOf(ZipRejected);
    await expect(extractZip(zip, dest, LIMITS)).rejects.toThrow(/bertabrakan/i);
    expect(await readdir(dest)).toEqual([]);
  });

  // Reproducer 3: byte NUL di nama entry. Sebelum fix, fs.writeFile/mkdir
  // melempar TypeError (ERR_INVALID_ARG_VALUE) di Fase 4 — bukan ZipRejected
  // — dengan "aman.txt" sudah keburu tertulis.
  it("menolak entry dengan byte NUL di namanya SEBELUM menulis apa pun", async () => {
    const zip = makeZip([
      { name: "aman.txt", data: Buffer.from("ok") },
      { name: "bad\0.txt", data: Buffer.from("x") },
    ]);
    await expect(extractZip(zip, dest, LIMITS)).rejects.toBeInstanceOf(ZipRejected);
    expect(await readdir(dest)).toEqual([]);
  });

  // Fase 4 harus semua-atau-tidak-sama-sekali walau validasi Fase 1-3 lolos
  // total: "sub" di sini adalah file yang SUDAH ADA sebelum extractZip
  // dipanggil (bukan buatan zip ini), jadi detectPathCollision (yang cuma
  // mengecek antar-entry DALAM zip yang sama) tidak melihatnya. Entry
  // pertama ("a.txt") berhasil dipindah ke dest, baru entry kedua
  // ("sub/b.txt") gagal saat commit karena "sub" bukan direktori. Entry
  // pertama yang sudah terlanjur pindah harus di-rollback (dihapus lagi).
  it("rollback: entry yang sudah terlanjur commit (dan direktorinya) dibuang lagi kalau entry berikutnya gagal", async () => {
    await writeFile(join(dest, "sub"), "file lama, bukan hasil extract");
    // "nested/a.txt" sengaja bersarang: rollback harus membuang FILE-nya
    // MAUPUN direktori "nested" yang jadi kosong sesudahnya — bukan cuma
    // filenya (itu sebabnya nama entry pertama tidak diletakkan di root).
    const zip = makeZip([
      { name: "nested/a.txt", data: Buffer.from("pertama") },
      { name: "sub/b.txt", data: Buffer.from("kedua") },
    ]);
    await expect(extractZip(zip, dest, LIMITS)).rejects.toThrow();
    // "nested/" (sempat berhasil commit) harus sudah di-rollback BERSAMA
    // direktorinya sendiri; "sub" (file lama, di luar tanggung jawab
    // extractZip) tetap seperti semula.
    expect(await readdir(dest)).toEqual(["sub"]);
    expect(await readFile(join(dest, "sub"), "utf8")).toBe("file lama, bukan hasil extract");
  });

  // Jendela yang lebih spesifik: direktori BARU yang dibuat mkdir() untuk
  // lokasi akhir suatu entry harus tercatat untuk rollback SAAT mkdir itu
  // sendiri berhasil — bukan menunggu rename entry itu sukses (lihat
  // penjelasan panjang di lib/intake.ts soal ini). Dua entry dengan nama
  // PERSIS SAMA memaksa rename yang nyata gagal (bukan mock): entry pertama
  // membuat "fresh/dir/" dari nol lalu berhasil dipindah (menghabiskan file
  // staging-nya); entry kedua (duplikat) mendapati direktori itu sudah ada
  // (mkdir tidak membuat apa-apa lagi) tapi source staging-nya sudah
  // dipindah entry pertama, jadi rename-nya gagal ENOENT sungguhan.
  it("rollback membuang direktori baru yang dibuat mkdir walau bukan entry yang gagal sendiri", async () => {
    const zip = makeZip([
      { name: "fresh/dir/a.txt", data: Buffer.from("pertama") },
      { name: "fresh/dir/a.txt", data: Buffer.from("kedua") }, // nama sama persis: duplikat
    ]);
    await expect(extractZip(zip, dest, LIMITS)).rejects.toThrow();
    // Direktori "fresh/" yang baru dibuat mkdir() untuk entry pertama HARUS
    // ikut dibuang meski entry yang gagal (entry kedua) bukan pemilik mkdir
    // itu -- dest harus balik kosong sepenuhnya.
    expect(await readdir(dest)).toEqual([]);
  });

  // Anti log-injection: nama entry dengan newline tidak boleh nongol mentah
  // di pesan error (yang juga mengalir ke log viewer aplikasi).
  it("meng-escape newline pada nama entry di pesan error (anti pemalsuan log)", async () => {
    const evil = "x\n[ERROR] deploy sukses\n";
    const zip = makeZip([{ name: evil, data: Buffer.from("x") }]);
    await expect(extractZip(zip, dest, LIMITS)).rejects.toBeInstanceOf(ZipRejected);
    try {
      await extractZip(zip, dest, LIMITS);
      throw new Error("harus melempar ZipRejected");
    } catch (err) {
      const message = (err as Error).message;
      expect(message).not.toContain("\n");             // tidak ada newline mentah
      expect(message).toContain(JSON.stringify(evil));  // representasi ter-escape ada
    }
    expect(await readdir(dest)).toEqual([]);
  });
});

describe("extractZip — normalisasi", () => {
  it("melepas satu direktori pembungkus", async () => {
    const zip = makeZip([
      { name: "myapp/Dockerfile", data: Buffer.from("FROM node") },
      { name: "myapp/package.json", data: Buffer.from("{}") },
    ]);
    const r = await extractZip(zip, dest, LIMITS);
    expect(r.strippedWrapper).toBe("myapp");
    expect(await readFile(join(dest, "Dockerfile"), "utf8")).toBe("FROM node");
  });

  it("TIDAK melepas apa pun kalau ada beberapa entry di root", async () => {
    const zip = makeZip([
      { name: "Dockerfile", data: Buffer.from("FROM node") },
      { name: "src/a.ts", data: Buffer.from("x") },
    ]);
    const r = await extractZip(zip, dest, LIMITS);
    expect(r.strippedWrapper).toBeNull();
    expect(await readFile(join(dest, "Dockerfile"), "utf8")).toBe("FROM node");
  });

  it("membuang .git supaya tidak bentrok dengan staging repo", async () => {
    const zip = makeZip([
      { name: "Dockerfile", data: Buffer.from("FROM node") },
      { name: ".git/config", data: Buffer.from("[core]") },
      { name: ".git/HEAD", data: Buffer.from("ref: x") },
    ]);
    await extractZip(zip, dest, LIMITS);
    expect(await readdir(dest)).toEqual(["Dockerfile"]);
  });

  it("membuang .git dengan huruf besar/campur juga (.GIT/config)", async () => {
    // Di filesystem case-insensitive (APFS/macOS, mount Linux CI), `.GIT/config`
    // ADALAH `.git/config` bagi OS — kalau lolos, ia menimpa config repo
    // staging yang lalu dijalankan `git add`/`commit` sebagai root (lihat
    // isGitInternal di lib/intake.ts). Filter harus case-insensitive.
    const zip = makeZip([
      { name: "Dockerfile", data: Buffer.from("FROM node") },
      { name: ".GIT/config", data: Buffer.from("[core]\n\tfsmonitor = touch /tmp/pwned") },
      { name: ".Git/HEAD", data: Buffer.from("ref: x") },
      { name: ".GIT", data: Buffer.from("x") },
    ]);
    await extractZip(zip, dest, LIMITS);
    expect(await readdir(dest)).toEqual(["Dockerfile"]);
  });

  it("menolak zip yang tidak menyisakan file apa pun", async () => {
    const zip = makeZip([{ name: ".git/config", data: Buffer.from("x") }]);
    await expect(extractZip(zip, dest, LIMITS)).rejects.toThrow(/tidak berisi file/i);
  });
});

describe("sanitizeUploadName", () => {
  it("membiarkan nama file biasa apa adanya", () => {
    expect(sanitizeUploadName("myapp-v2.zip")).toBe("myapp-v2.zip");
  });

  it("membuang karakter kontrol termasuk ESC dan newline (pemalsuan log)", () => {
    expect(sanitizeUploadName("x\n[ERROR] deploy sukses\n.zip")).toBe("x[ERROR] deploy sukses.zip");
    expect(sanitizeUploadName("evil\x1b[31mred\x1b[0m.zip")).toBe("evil[31mred[0m.zip");
    expect(sanitizeUploadName("a\rb\tc\x7f.zip")).toBe("abc.zip");
  });

  it("membatasi panjang nama ke 255 karakter", () => {
    const long = "a".repeat(500) + ".zip";
    const out = sanitizeUploadName(long);
    expect(out.length).toBe(255);
    expect(out).toBe("a".repeat(255));
  });

  it("memakai fallback kalau hasil sanitasi kosong", () => {
    expect(sanitizeUploadName("\x1b\x1b\x1b")).toBe("upload.zip");
    expect(sanitizeUploadName("")).toBe("upload.zip");
  });
});
