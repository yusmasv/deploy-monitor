import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractZip } from "../lib/intake";
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

  it("menolak zip yang tidak menyisakan file apa pun", async () => {
    const zip = makeZip([{ name: ".git/config", data: Buffer.from("x") }]);
    await expect(extractZip(zip, dest, LIMITS)).rejects.toThrow(/tidak berisi file/i);
  });
});
