import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openDb, type Db } from "../lib/db";
import { LocalExecutor } from "../lib/executor/local";
import { Runner, OVERRIDES_DIR } from "../lib/runner";
import { bus } from "../lib/bus";
import { normalizeProject } from "../lib/project";
import { makeZip } from "./helpers/zip";
import { stripAnsi } from "../lib/phases";

const FAKE = resolve(__dirname, "fixtures/fake-deploy.sh");
let db: Db, uploads: string, runner: Runner;

const build = (extraEnv: Record<string, string> = {}) => {
  runner = new Runner({
    db,
    executor: new LocalExecutor(),
    deploySh: FAKE,
    uploadsDir: uploads,
    publicHost: "203.0.113.9",
    limits: { maxTotalBytes: 1e6, maxEntries: 100 },
    extraEnv,
  });
};

beforeEach(async () => {
  db = openDb(":memory:");
  uploads = await mkdtemp(join(tmpdir(), "runner-"));
  build();
});
afterEach(async () => { await rm(uploads, { recursive: true, force: true }); });

const zip = () => makeZip([{ name: "Dockerfile", data: Buffer.from("FROM node") }]);
const text = (id: string) => db.getLines(id, 0).map((l) => stripAnsi(l.text));

describe("Runner", () => {
  it("menjalankan deploy sampai sukses dan menyimpan ringkasannya", async () => {
    const id = await runner.enqueue({ project: "app", zip: zip(), zipName: "a.zip", env: [] });
    await runner.waitForIdle();

    const d = db.getDeploy(id)!;
    expect(d.status).toBe("success");
    expect(d.exit_code).toBe(0);
    expect(d.sha).toBe("deadbee");
    expect(d.image).toBe("10.8.0.2:5000/app:deadbee");
    expect(d.app_port).toBe(3000);
    expect(d.live_url).toBe("http://203.0.113.9:3000");
  });

  it("menandai gagal dari exit code, bukan dari teks log", async () => {
    build({ FAKE_EXIT: "1" });
    const id = await runner.enqueue({ project: "app", zip: zip(), zipName: "a.zip", env: [] });
    await runner.waitForIdle();

    const d = db.getDeploy(id)!;
    expect(d.status).toBe("failed");
    expect(d.exit_code).toBe(1);
    // "Deployment completed." tetap tercetak, tapi tidak mempengaruhi status.
    expect(text(id)).toContain("Deployment completed.");
  });

  it("menyimpan log stdout dan stderr beserta ANSI-nya", async () => {
    const id = await runner.enqueue({ project: "app", zip: zip(), zipName: "a.zip", env: [] });
    await runner.waitForIdle();

    expect(text(id)).toContain("gagal-di-stderr");
    expect(db.getLines(id, 0).some((l) => l.stream === "stderr")).toBe(true);
    expect(db.getLines(id, 0).some((l) => l.text.includes("\x1b["))).toBe(true);
  });

  it("memajukan fase mengikuti penanda", async () => {
    const id = await runner.enqueue({ project: "app", zip: zip(), zipName: "a.zip", env: [] });
    await runner.waitForIdle();
    expect(db.getDeploy(id)!.phase).toBe("start");
  });

  it("mengoper ENV_OVERRIDES_FILE hanya kalau ada env yang diisi", async () => {
    const withEnv = await runner.enqueue({
      project: "app", zip: zip(), zipName: "a.zip", env: [{ key: "SMTP_HOST", value: "mail.x" }],
    });
    await runner.waitForIdle();
    expect(text(withEnv).some((l) => l.startsWith("OVERRIDES_SEEN="))).toBe(true);

    const noEnv = await runner.enqueue({ project: "app", zip: zip(), zipName: "a.zip", env: [] });
    await runner.waitForIdle();
    expect(text(noEnv).some((l) => l.startsWith("OVERRIDES_SEEN="))).toBe(false);
  });

  it("menyimpan nama key env, tidak pernah nilainya", async () => {
    const id = await runner.enqueue({
      project: "app", zip: zip(), zipName: "a.zip",
      env: [{ key: "SMTP_PASS", value: "RAHASIA_BANGET" }],
    });
    await runner.waitForIdle();

    expect(JSON.parse(db.getDeploy(id)!.env_keys)).toEqual(["SMTP_PASS"]);
    expect(JSON.stringify(db.getDeploy(id))).not.toContain("RAHASIA_BANGET");
    expect(text(id).join("\n")).not.toContain("RAHASIA_BANGET");
  });

  it("menghapus file override setelah deploy selesai", async () => {
    const id = await runner.enqueue({
      project: "app", zip: zip(), zipName: "a.zip", env: [{ key: "A", value: "1" }],
    });
    await runner.waitForIdle();

    const path = text(id).find((l) => l.startsWith("OVERRIDES_SEEN="))!.split("=")[1];
    const { access } = await import("node:fs/promises");
    await expect(access(path)).rejects.toThrow();
  });

  it("menjalankan deploy satu per satu, tidak paralel", async () => {
    const a = await runner.enqueue({ project: "app", zip: zip(), zipName: "a.zip", env: [] });
    const b = await runner.enqueue({ project: "app", zip: zip(), zipName: "b.zip", env: [] });
    expect(db.getDeploy(b)!.status).toBe("queued");

    await runner.waitForIdle();
    expect(db.getDeploy(a)!.status).toBe("success");
    expect(db.getDeploy(b)!.status).toBe("success");
  });

  it("menandai gagal kalau zip ditolak, tanpa menjalankan deploy.sh", async () => {
    const bad = makeZip([{ name: "../jahat", data: Buffer.from("x") }]);
    const id = await runner.enqueue({ project: "app", zip: bad, zipName: "b.zip", env: [] });
    await runner.waitForIdle();

    const d = db.getDeploy(id)!;
    expect(d.status).toBe("failed");
    expect(d.error).toMatch(/keluar dari direktori/i);
  });

  // Finding 1: tidak ada nama project yang bisa membuat prepareStaging()
  // menaruh staging git repo tepat di direktori tempat Runner menulis file
  // override. normalizeProject() SELALU men-toLowerCase() input sebelum
  // memfilter karakter, jadi keluarannya tidak pernah mengandung huruf
  // besar — properti ini berlaku untuk STRING apapun, tidak cuma nama
  // project "masuk akal", jadi cukup dibuktikan sekali lewat OVERRIDES_DIR
  // itu sendiri sebagai kasus yang paling mungkin menabrak (karena namanya
  // sengaja dibuat mirip skema lama).
  it("nama direktori override tidak pernah bisa dihasilkan normalizeProject", () => {
    expect(OVERRIDES_DIR).not.toBe(OVERRIDES_DIR.toLowerCase());
    expect(normalizeProject(OVERRIDES_DIR)).not.toBe(OVERRIDES_DIR);
    // Konsekuensi langsungnya: upload dengan nama project apapun yang
    // "kelihatan seperti" OVERRIDES_DIR (mis. huruf kecil semua) tetap
    // menghasilkan direktori staging yang berbeda dari direktori override.
    expect(normalizeProject(OVERRIDES_DIR.toLowerCase())).not.toBe(OVERRIDES_DIR);
  });

  // Finding 2: listener bus yang throw (mis. rute SSE menulis ke stream
  // yang sudah ditutup) tidak boleh pernah menjatuhkan antrian secara
  // permanen. Deploy kedua harus tetap selesai walau deploy pertama
  // memicu exception di setiap listener 'state:'/'line:'-nya.
  it("tidak macet walau listener bus melempar exception", async () => {
    const boom = () => { throw new Error("simulasi: listener SSE meledak"); };

    const a = await runner.enqueue({ project: "app", zip: zip(), zipName: "a.zip", env: [] });
    bus.on(`state:${a}`, boom);
    bus.on(`line:${a}`, boom);

    try {
      const b = await runner.enqueue({ project: "app", zip: zip(), zipName: "b.zip", env: [] });
      await runner.waitForIdle();

      // Deploy 'a' sendiri tidak boleh gagal gara-gara listener orang lain.
      expect(db.getDeploy(a)!.status).toBe("success");
      // Antrian tidak macet: deploy 'b' tetap jalan sampai selesai.
      expect(db.getDeploy(b)!.status).toBe("success");
    } finally {
      bus.off(`state:${a}`, boom);
      bus.off(`line:${a}`, boom);
    }
  });
});
