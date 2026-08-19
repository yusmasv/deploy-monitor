import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, access, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, basename, resolve, sep } from "node:path";
import { prepareStaging } from "../lib/staging";
import { makeZip } from "./helpers/zip";

const LIMITS = { maxTotalBytes: 1e6, maxEntries: 100 };
let uploads: string;

beforeEach(async () => { uploads = await mkdtemp(join(tmpdir(), "uploads-")); });
afterEach(async () => { await rm(uploads, { recursive: true, force: true }); });

// Tidak boleh ada sisa direktori staging (.Staging-*) atau backup (.orphan-*)
// tertinggal di uploadsDir setelah prepareStaging selesai — keduanya cuma
// boleh ada SEMENTARA selama swap berlangsung.
async function leftovers(): Promise<string[]> {
  return (await readdir(uploads)).filter((n) => n.startsWith(".Staging-") || n.includes(".orphan-"));
}

describe("prepareStaging", () => {
  it("membuat direktori yang basename-nya sama persis dengan nama project, tanpa sisa staging", async () => {
    const zip = makeZip([{ name: "Dockerfile", data: Buffer.from("FROM node") }]);
    const { dir } = await prepareStaging({ project: "kanban-clone", zip, uploadsDir: uploads, limits: LIMITS });

    expect(basename(dir)).toBe("kanban-clone");   // deploy.sh mengambil basename ini
    expect(await readFile(join(dir, "Dockerfile"), "utf8")).toBe("FROM node");
    expect(await leftovers()).toEqual([]);
  });

  it("upload kedua menimpa isi lama: file yang hilang di zip baru ikut terhapus", async () => {
    const p = { project: "app", uploadsDir: uploads, limits: LIMITS };
    await prepareStaging({ ...p, zip: makeZip([
      { name: "a.txt", data: Buffer.from("v1") },
      { name: "hapus-aku.txt", data: Buffer.from("x") },
    ]) });
    const { dir } = await prepareStaging({ ...p, zip: makeZip([
      { name: "a.txt", data: Buffer.from("v2") },
    ]) });

    expect(await readFile(join(dir, "a.txt"), "utf8")).toBe("v2");
    await expect(access(join(dir, "hapus-aku.txt"))).rejects.toThrow();
    expect(await leftovers()).toEqual([]);
  });

  it("upload berulang dengan isi identik tetap berhasil, tanpa sisa staging", async () => {
    const p = { project: "app", uploadsDir: uploads, limits: LIMITS };
    const zip = () => makeZip([{ name: "a.txt", data: Buffer.from("sama") }]);

    const a = await prepareStaging({ ...p, zip: zip() });
    const b = await prepareStaging({ ...p, zip: zip() });

    expect(await readFile(join(b.dir, "a.txt"), "utf8")).toBe("sama");
    expect(a.dir).toBe(b.dir);
    expect(await leftovers()).toEqual([]);
  });

  it("zip yang ditolak tidak merusak upload yang sudah baik", async () => {
    const p = { project: "app", uploadsDir: uploads, limits: LIMITS };
    const { dir } = await prepareStaging({ ...p, zip: makeZip([{ name: "a.txt", data: Buffer.from("baik") }]) });

    await expect(prepareStaging({ ...p, zip: makeZip([{ name: "../jahat", data: Buffer.from("x") }]) }))
      .rejects.toThrow();

    expect(await readFile(join(dir, "a.txt"), "utf8")).toBe("baik");
    expect(await readdir(dir)).toEqual(["a.txt"]);
    expect(await leftovers()).toEqual([]);
  });
});

describe("prepareStaging - nama project tidak boleh keluar dari uploadsDir", () => {
  // opts.project verbatim di-join ke uploadsDir. Sebelum fix, join(uploadsDir,
  // "../../etc/cron.d") menghasilkan "/etc/cron.d" — file write di luar
  // uploadsDir, sebagai root. normalizeProject() sekarang dipanggil di dalam
  // prepareStaging, jadi ini juga menguji dari sisi keamanan, bukan cuma
  // konsistensi nama seperti test project.test.ts.

  it("menolak '..' murni (normalizeProject menolaknya secara eksplisit)", async () => {
    const p = { project: "..", uploadsDir: uploads, limits: LIMITS };
    await expect(
      prepareStaging({ ...p, zip: makeZip([{ name: "a.txt", data: Buffer.from("x") }]) }),
    ).rejects.toThrow();
  });

  // Catatan verifikasi: normalizeProject mengganti SETIAP karakter di luar
  // [a-z0-9._-] (termasuk '/') dengan '-'. Jadi "../../etc/cron.d" dan
  // "a/../../../tmp/x" TIDAK membuat prepareStaging melempar — keduanya
  // disanitasi menjadi satu nama direktori aneh tapi aman ("..-..-etc-cron.d"
  // dan "a-..-..-..-tmp-x") yang tidak pernah mengandung '/', sehingga
  // join(uploadsDir, project) tidak bisa lagi menghasilkan path di luar
  // uploadsDir. Yang dibuktikan test ini bukan "melempar", melainkan
  // properti keamanan yang sebenarnya diminta: dir yang dihasilkan selalu
  // ada DI DALAM uploadsDir, tidak pernah keluar.
  it.each(["../../etc/cron.d", "a/../../../tmp/x"])(
    "mensanitasi '/' pada project=%s sehingga dir tetap di dalam uploadsDir",
    async (project) => {
      const { dir } = await prepareStaging({
        project,
        uploadsDir: uploads,
        limits: LIMITS,
        zip: makeZip([{ name: "a.txt", data: Buffer.from("x") }]),
      });

      const root = resolve(uploads);
      const resolvedDir = resolve(dir);
      expect(resolvedDir).not.toBe(root);
      expect(resolvedDir.startsWith(root + sep)).toBe(true);
    },
  );
});
