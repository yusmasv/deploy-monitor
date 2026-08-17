import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, access } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
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
