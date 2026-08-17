import { describe, it, expect, beforeEach } from "vitest";
import { openDb, type Db } from "../lib/db";

let db: Db;
beforeEach(() => { db = openDb(":memory:"); });

const seed = (id = "d1") =>
  db.createDeploy({ id, project: "app", zipName: "a.zip", zipSize: 10, envKeys: ["SMTP_HOST"] });

describe("deploys", () => {
  it("membuat deploy dengan status queued", () => {
    seed();
    const d = db.getDeploy("d1")!;
    expect(d.status).toBe("queued");
    expect(d.project).toBe("app");
    expect(JSON.parse(d.env_keys)).toEqual(["SMTP_HOST"]);
  });

  it("menyimpan nama key saja, tidak pernah nilainya", () => {
    seed();
    expect(JSON.stringify(db.getDeploy("d1"))).not.toContain("value");
  });

  it("memperbarui sebagian field", () => {
    seed();
    db.updateDeploy("d1", { status: "success", exit_code: 0, sha: "abc", app_port: 3000 });
    const d = db.getDeploy("d1")!;
    expect(d.status).toBe("success");
    expect(d.app_port).toBe(3000);
    expect(d.project).toBe("app");           // field lain tidak tersentuh
  });

  it("mengurutkan daftar dari yang terbaru", () => {
    db.createDeploy({ id: "a", project: "p", zipName: "z", zipSize: 1, envKeys: [] });
    db.createDeploy({ id: "b", project: "p", zipName: "z", zipSize: 1, envKeys: [] });
    expect(db.listDeploys(10).map((d) => d.id)).toEqual(["b", "a"]);
  });
});

describe("log_lines", () => {
  it("memberi seq yang berurutan per deploy", () => {
    seed("d1"); seed("d2");
    expect(db.appendLine("d1", "stdout", "a")).toBe(1);
    expect(db.appendLine("d1", "stderr", "b")).toBe(2);
    expect(db.appendLine("d2", "stdout", "c")).toBe(1);   // penomoran terpisah
  });

  it("mengambil baris setelah seq tertentu — dipakai reconnect SSE", () => {
    seed();
    for (const t of ["a", "b", "c"]) db.appendLine("d1", "stdout", t);
    expect(db.getLines("d1", 1).map((l) => l.text)).toEqual(["b", "c"]);
    expect(db.getLines("d1", 0)).toHaveLength(3);
  });

  it("menyimpan teks mentah termasuk ANSI", () => {
    seed();
    const raw = "\x1b[0;32mok\x1b[0m";
    db.appendLine("d1", "stdout", raw);
    expect(db.getLines("d1", 0)[0].text).toBe(raw);
  });
});

describe("markRunningAsInterrupted", () => {
  it("membereskan deploy yatim setelah service restart", () => {
    seed("d1"); seed("d2"); seed("d3");
    db.updateDeploy("d1", { status: "running" });
    db.updateDeploy("d2", { status: "success" });
    // d3 tetap queued

    expect(db.markRunningAsInterrupted()).toBe(2);   // running + queued
    expect(db.getDeploy("d1")!.status).toBe("interrupted");
    expect(db.getDeploy("d2")!.status).toBe("success");
    expect(db.getDeploy("d3")!.status).toBe("interrupted");
  });
});
