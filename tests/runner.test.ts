import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openDb, type Db } from "../lib/db";
import { LocalExecutor } from "../lib/executor/local";
import { Runner } from "../lib/runner";
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
});
