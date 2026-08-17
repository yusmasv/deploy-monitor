import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, access, writeFile, chmod } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, basename, resolve, sep } from "node:path";
import { prepareStaging } from "../lib/staging";
import { makeZip } from "./helpers/zip";

const LIMITS = { maxTotalBytes: 1e6, maxEntries: 100 };
let uploads: string;
const git = (dir: string, ...args: string[]) =>
  execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();

beforeEach(async () => { uploads = await mkdtemp(join(tmpdir(), "uploads-")); });
afterEach(async () => { await rm(uploads, { recursive: true, force: true }); });

describe("prepareStaging", () => {
  it("membuat repo yang basename-nya sama persis dengan nama project", async () => {
    const zip = makeZip([{ name: "Dockerfile", data: Buffer.from("FROM node") }]);
    const { dir } = await prepareStaging({ project: "kanban-clone", zip, uploadsDir: uploads, limits: LIMITS });

    expect(basename(dir)).toBe("kanban-clone");   // deploy.sh mengambil basename ini
    expect(git(dir, "symbolic-ref", "HEAD")).toBe("refs/heads/main");
    expect(git(dir, "log", "--oneline")).toContain("upload");
  });

  it("upload kedua jadi commit kedua, dan penghapusan file ikut terpropagasi", async () => {
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
    expect(git(dir, "log", "--oneline").split("\n")).toHaveLength(2);
  });

  it("zip identik tetap menghasilkan commit baru — --allow-empty", async () => {
    const p = { project: "app", uploadsDir: uploads, limits: LIMITS };
    const zip = () => makeZip([{ name: "a.txt", data: Buffer.from("sama") }]);

    const a = await prepareStaging({ ...p, zip: zip() });
    const sha1 = git(a.dir, "rev-parse", "HEAD");
    const b = await prepareStaging({ ...p, zip: zip() });
    const sha2 = git(b.dir, "rev-parse", "HEAD");

    expect(sha2).not.toBe(sha1);   // tag image baru, tidak tertukar dengan yang lama
  });

  it("zip yang ditolak tidak merusak upload yang sudah baik", async () => {
    const p = { project: "app", uploadsDir: uploads, limits: LIMITS };
    const { dir } = await prepareStaging({ ...p, zip: makeZip([{ name: "a.txt", data: Buffer.from("baik") }]) });

    await expect(prepareStaging({ ...p, zip: makeZip([{ name: "../jahat", data: Buffer.from("x") }]) }))
      .rejects.toThrow();

    expect(await readFile(join(dir, "a.txt"), "utf8")).toBe("baik");
    expect(git(dir, "log", "--oneline").split("\n")).toHaveLength(1);
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

describe("prepareStaging - pemulihan setelah gagal pasca dir tersentuh", () => {
  it("working tree dipulihkan ke commit terakhir kalau git commit ditolak pre-commit hook", async () => {
    const p = { project: "app", uploadsDir: uploads, limits: LIMITS };
    const { dir } = await prepareStaging({
      ...p,
      zip: makeZip([{ name: "a.txt", data: Buffer.from("lama") }]),
    });

    // Hook nyata, dijalankan oleh git betulan — bukan mock. Selalu menolak
    // commit, mensimulasikan kegagalan apa pun yang terjadi setelah working
    // tree sudah diganti tapi sebelum commit selesai (mis. ENOSPC).
    const hookPath = join(dir, ".git", "hooks", "pre-commit");
    await writeFile(hookPath, "#!/bin/sh\nexit 1\n");
    await chmod(hookPath, 0o755);

    await expect(
      prepareStaging({ ...p, zip: makeZip([{ name: "a.txt", data: Buffer.from("baru") }]) }),
    ).rejects.toThrow();

    // Tanpa pemulihan, working tree akan menunjukkan "baru" (sudah di-cp)
    // walau HEAD masih di commit lama — index & working tree konsisten
    // dengan commit terakhir, bukan tertinggal setengah jalan.
    expect(await readFile(join(dir, "a.txt"), "utf8")).toBe("lama");
    expect(git(dir, "status", "--porcelain")).toBe("");
    expect(git(dir, "log", "--oneline").split("\n")).toHaveLength(1);
  });
});
