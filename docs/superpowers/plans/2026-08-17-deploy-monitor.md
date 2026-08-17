# Deploy Monitor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Aplikasi FE+BE di VPS1 yang menerima zip + env var, menjalankan `deploy.sh` yang sudah ada, dan menyiarkan log berwarna secara realtime dengan riwayat tersimpan.

**Architecture:** Next.js App Router jalan sebagai systemd service di VPS1 (build host). Upload zip di-extract ke staging git repo di `/srv/uploads/<project>`, di-commit, lalu `deploy.sh <path>` dipanggil sebagai child process — sehingga `deploy.sh` tidak berubah sama sekali untuk alur zip. Stdout/stderr dibaca baris demi baris, disimpan ke SQLite, dan disiarkan lewat SSE. Env var dari user dikirim sebagai file override yang di-`scp` `deploy.sh` ke VPS2, lalu di-upsert per-key oleh `run.sh` ke dalam `app.env`.

**Tech Stack:** Next.js 16 (App Router), React 19, TypeScript, Tailwind 4, `node:sqlite` (bawaan Node 24 — nol dependency native), `yauzl` (extract zip), `ssh2` (khusus mode dev), Vitest.

**Spec:** `docs/superpowers/specs/2026-08-17-deploy-monitor-design.md`

## Global Constraints

- **Node 24+ wajib.** `node:sqlite` baru stabil tanpa warning di Node 24; ini yang membuat aplikasi bebas dependency native.
- **Aplikasi berjalan sebagai root di VPS1.** Setiap kode yang menyentuh path dari input user harus menganggap input itu bermusuhan.
- **Nilai env var tidak boleh masuk ke log maupun database.** Hanya nama key yang boleh disimpan (spec D7). Ini berlaku untuk pesan error juga.
- **Sukses/gagal deploy SELALU dari exit code**, tidak pernah dari parsing teks log (spec §8).
- **Nama project harus kanonik** sesuai aturan `deploy.sh:70`: lowercase, karakter di luar `[a-z0-9._-]` jadi `-`, buang `-` di akhir.
- **`deploy.sh` nol baris berubah untuk alur zip.** Delapan baris tambahannya khusus env override dan harus opsional — tanpa `ENV_OVERRIDES_FILE`, perilakunya identik dengan sekarang.
- **File override env `chmod 600`** dan dihapus setelah deploy selesai, sukses maupun gagal.
- Semua tulisan yang dilihat user (UI, `setup.md`, `runbook.md`) memakai **Bahasa Indonesia**, konsisten dengan `DEPLOYMENT.md`.

---

## File Structure

| File | Tanggung jawab |
|---|---|
| `lib/config.ts` | Baca + validasi env var aplikasi saat boot |
| `lib/project.ts` | Normalisasi nama project (port dari `deploy.sh:70`) |
| `lib/intake.ts` | Extract zip dengan aman (zip-slip, wrapper dir, limit) |
| `lib/staging.ts` | Sinkron ke `/srv/uploads/<p>` + `git init`/`commit` |
| `lib/envfile.ts` | Validasi + serialisasi override env |
| `lib/ansi.ts` | ANSI SGR → span berwarna |
| `lib/phases.ts` | Baris log → fase deploy + ringkasan (sha/image/port) |
| `lib/db.ts` | Skema SQLite + semua query |
| `lib/bus.ts` | EventEmitter in-process untuk SSE |
| `lib/executor/types.ts` | Interface `Executor` |
| `lib/executor/local.ts` | `spawn()` — dipakai di produksi |
| `lib/executor/ssh.ts` | `ssh2` — hanya untuk dev dari laptop |
| `lib/executor/index.ts` | Pilih implementasi dari `EXECUTOR` |
| `lib/runner.ts` | Antrian + orkestrasi deploy |
| `lib/auth.ts` | Verifikasi token + cookie |
| `app/api/**` | Route handler |
| `app/**` | Halaman + komponen |
| `deploy/deploy.sh` | +8 baris (kirim override ke VPS2) |
| `deploy/run.sh` | +25 baris (`env_set` upsert) |
| `setup.md`, `runbook.md` | Dokumentasi |

---

### Task 1: Fondasi — git, dependency, config

**Files:**
- Create: `vitest.config.ts`, `lib/config.ts`, `tests/config.test.ts`, `.gitignore` (ubah)
- Modify: `package.json`

**Interfaces:**
- Consumes: —
- Produces: `getConfig(): Config` dengan field `monitorToken, executor, deploySh, uploadsDir, dbPath, publicHost, maxZipBytes, ssh?`. Melempar `Error` kalau `MONITOR_TOKEN` kosong.

- [ ] **Step 1: Inisialisasi git dan pasang dependency**

```bash
cd /Users/gustiagung/Desktop/aisahub/deploy-monitor
git init -b main
npm install yauzl ssh2
npm install -D vitest @types/yauzl @types/ssh2
```

- [ ] **Step 2: Tambahkan script test ke `package.json`**

Di dalam `"scripts"`, tambahkan:

```json
"test": "vitest run",
"test:watch": "vitest"
```

- [ ] **Step 3: Buat `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
```

- [ ] **Step 4: Tambahkan baris ini ke `.gitignore`**

```
/srv-test
*.db
```

- [ ] **Step 5: Tulis test yang gagal**

`tests/config.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { loadConfig } from "../lib/config";

describe("loadConfig", () => {
  it("menolak MONITOR_TOKEN yang kosong", () => {
    expect(() => loadConfig({})).toThrow(/MONITOR_TOKEN/);
  });

  it("memakai default yang masuk akal", () => {
    const c = loadConfig({ MONITOR_TOKEN: "rahasia" });
    expect(c.executor).toBe("local");
    expect(c.deploySh).toBe("/srv/platform/deploy.sh");
    expect(c.uploadsDir).toBe("/srv/uploads");
    expect(c.maxZipBytes).toBe(200 * 1024 * 1024);
  });

  it("mewajibkan SSH_HOST saat executor=ssh", () => {
    expect(() => loadConfig({ MONITOR_TOKEN: "x", EXECUTOR: "ssh" })).toThrow(/SSH_HOST/);
  });
});
```

- [ ] **Step 6: Jalankan test, pastikan GAGAL**

Run: `npm test -- tests/config.test.ts`
Expected: FAIL — `Cannot find module '../lib/config'`

- [ ] **Step 7: Implementasi `lib/config.ts`**

```ts
export type ExecutorKind = "local" | "ssh";

export interface Config {
  monitorToken: string;
  executor: ExecutorKind;
  deploySh: string;
  uploadsDir: string;
  dbPath: string;
  publicHost: string;
  maxZipBytes: number;
  ssh?: { host: string; user: string; keyPath: string };
}

export function loadConfig(env: Record<string, string | undefined>): Config {
  const monitorToken = (env.MONITOR_TOKEN ?? "").trim();
  if (!monitorToken) {
    throw new Error("MONITOR_TOKEN wajib diisi — aplikasi ini menjalankan deploy sebagai root.");
  }

  const executor = (env.EXECUTOR ?? "local") as ExecutorKind;
  if (executor !== "local" && executor !== "ssh") {
    throw new Error(`EXECUTOR harus 'local' atau 'ssh', bukan '${executor}'.`);
  }

  let ssh: Config["ssh"];
  if (executor === "ssh") {
    const host = (env.SSH_HOST ?? "").trim();
    if (!host) throw new Error("EXECUTOR=ssh membutuhkan SSH_HOST.");
    ssh = {
      host,
      user: env.SSH_USER ?? "root",
      keyPath: env.SSH_KEY ?? `${env.HOME ?? ""}/.ssh/id_ed25519`,
    };
  }

  return {
    monitorToken,
    executor,
    deploySh: env.DEPLOY_SH ?? "/srv/platform/deploy.sh",
    uploadsDir: env.UPLOADS_DIR ?? "/srv/uploads",
    dbPath: env.DB_PATH ?? "/srv/monitor/monitor.db",
    publicHost: (env.PUBLIC_HOST ?? "").trim(),
    maxZipBytes: Number(env.MAX_ZIP_BYTES ?? 200 * 1024 * 1024),
    ssh,
  };
}

let cached: Config | undefined;
export function getConfig(): Config {
  cached ??= loadConfig(process.env);
  return cached;
}
```

- [ ] **Step 8: Jalankan test, pastikan LULUS**

Run: `npm test -- tests/config.test.ts`
Expected: PASS (3 test)

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "chore: fondasi proyek, dependency, dan config tervalidasi"
```

---

### Task 2: Normalisasi nama project

Ini yang paling halus di seluruh proyek. Kalau aturannya beda sedikit saja dengan `deploy.sh:70`, direktori upload dan `PROJECT` jadi berbeda → `/srv/data/<project>` lama tidak ketemu → aplikasi terlihat seperti kehilangan seluruh datanya.

**Files:**
- Create: `lib/project.ts`, `tests/project.test.ts`

**Interfaces:**
- Consumes: —
- Produces: `normalizeProject(raw: string): string` — melempar `Error` kalau hasilnya kosong.

- [ ] **Step 1: Tulis test yang gagal**

`tests/project.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { normalizeProject } from "../lib/project";

describe("normalizeProject", () => {
  it("menirukan aturan deploy.sh:70", () => {
    expect(normalizeProject("Kanban-Clone")).toBe("kanban-clone");
    expect(normalizeProject("My App!")).toBe("my-app");     // spasi & '!' -> '-', trailing dibuang
    expect(normalizeProject("app_v2.1")).toBe("app_v2.1");  // '_' '.' aman
  });

  it("membuang '-' hanya di akhir, seperti ${PROJECT%-}", () => {
    expect(normalizeProject("app--")).toBe("app-");
    expect(normalizeProject("-app")).toBe("-app");
  });

  it("idempoten — syarat mutlak karena deploy.sh menormalkan ulang basename kita", () => {
    for (const s of ["Kanban-Clone", "My App!", "app_v2.1", "app--", "a b c", "ÜBER"]) {
      const once = normalizeProject(s);
      expect(normalizeProject(once)).toBe(once);
    }
  });

  it("menolak nama yang menyusut jadi kosong atau berbahaya", () => {
    expect(() => normalizeProject("")).toThrow();
    expect(() => normalizeProject("-")).toThrow();
    expect(() => normalizeProject("..")).toThrow();
    expect(() => normalizeProject(".")).toThrow();
  });
});
```

- [ ] **Step 2: Jalankan test, pastikan GAGAL**

Run: `npm test -- tests/project.test.ts`
Expected: FAIL — modul belum ada

- [ ] **Step 3: Implementasi `lib/project.ts`**

```ts
// Port persis dari deploy.sh:69-71
//   PROJECT="$(printf '%s' "$PROJECT" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9._-' '-')"
//   PROJECT="${PROJECT%-}"
// Kita mengoper PATH ke deploy.sh dan dia mengambil basename-nya, lalu menormalkan
// ULANG. Jadi nama direktori kita harus sudah jadi titik-tetap dari fungsi ini —
// kalau tidak, PROJECT milik deploy.sh berbeda dari nama direktori kita dan
// /srv/data/<project> yang lama tidak akan ditemukan.
export function normalizeProject(raw: string): string {
  let s = raw.toLowerCase().replace(/[^a-z0-9._-]/g, "-");
  s = s.replace(/-$/, ""); // hanya SATU, persis seperti ${PROJECT%-}

  if (s === "" || s === "." || s === "..") {
    throw new Error(
      `Nama project '${raw}' tidak valid — setelah dinormalkan tidak menyisakan karakter yang bisa dipakai.`,
    );
  }
  return s;
}
```

- [ ] **Step 4: Jalankan test, pastikan LULUS**

Run: `npm test -- tests/project.test.ts`
Expected: PASS (4 test)

- [ ] **Step 5: Commit**

```bash
git add lib/project.ts tests/project.test.ts
git commit -m "feat: normalisasi nama project yang cocok persis dengan deploy.sh"
```

---

### Task 3: Extract zip yang aman

Aplikasi ini jalan sebagai root. Ini permukaan serangan paling serius di seluruh proyek.

**Files:**
- Create: `lib/intake.ts`, `tests/intake.test.ts`, `tests/helpers/zip.ts`

**Interfaces:**
- Consumes: —
- Produces: `extractZip(buf: Buffer, destDir: string, limits: ZipLimits): Promise<ExtractResult>` di mana `ZipLimits = { maxTotalBytes: number; maxEntries: number }` dan `ExtractResult = { fileCount: number; totalBytes: number; strippedWrapper: string | null }`. Melempar `ZipRejected` (subclass `Error` dengan field `reason: string`).

- [ ] **Step 1: Buat helper pembuat zip untuk test**

`tests/helpers/zip.ts` — membangun zip di memori tanpa dependency tambahan, memakai `deflateRawSync` bawaan Node:

```ts
import { deflateRawSync, crc32 } from "node:zlib";

export interface Entry { name: string; data?: Buffer }

/** Membangun arsip ZIP minimal tapi valid. Nama entry dipakai APA ADANYA
 *  supaya test bisa menyuntikkan '../' dan path absolut. */
export function makeZip(entries: Entry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const raw = e.data ?? Buffer.alloc(0);
    const comp = deflateRawSync(raw);
    const crc = crc32(raw);

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(8, 8);              // deflate
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(name.length, 26);
    locals.push(lh, name, comp);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, name);

    offset += 30 + name.length + comp.length;
  }

  const central = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, central, eocd]);
}
```

- [ ] **Step 2: Tulis test yang gagal**

`tests/intake.test.ts`:

```ts
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
```

- [ ] **Step 3: Jalankan test, pastikan GAGAL**

Run: `npm test -- tests/intake.test.ts`
Expected: FAIL — modul belum ada

- [ ] **Step 4: Implementasi `lib/intake.ts`**

Perhatikan strateginya: **validasi seluruh daftar entry lebih dulu, baru menulis**. Zip jahat tidak boleh meninggalkan satu byte pun di disk.

```ts
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import yauzl from "yauzl";

export interface ZipLimits { maxTotalBytes: number; maxEntries: number }
export interface ExtractResult { fileCount: number; totalBytes: number; strippedWrapper: string | null }

export class ZipRejected extends Error {
  constructor(public reason: string) { super(reason); this.name = "ZipRejected"; }
}

interface Planned { path: string; buf: Buffer }

function openZip(buf: Buffer): Promise<yauzl.ZipFile> {
  return new Promise((res, rej) =>
    yauzl.fromBuffer(buf, { lazyEntries: true }, (err, zf) =>
      err || !zf ? rej(new ZipRejected("File yang diunggah bukan file zip yang valid.")) : res(zf),
    ),
  );
}

function readEntry(zf: yauzl.ZipFile, e: yauzl.Entry): Promise<Buffer> {
  return new Promise((res, rej) =>
    zf.openReadStream(e, (err, rs) => {
      if (err || !rs) return rej(new ZipRejected(`Gagal membaca entry '${e.fileName}'.`));
      const chunks: Buffer[] = [];
      rs.on("data", (c: Buffer) => chunks.push(c));
      rs.on("end", () => res(Buffer.concat(chunks)));
      rs.on("error", () => rej(new ZipRejected(`Entry '${e.fileName}' rusak.`)));
    }),
  );
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
          const name = e.fileName.replace(/\\/g, "/");
          if (name.endsWith("/")) return zf.readEntry();          // direktori: lewati

          safeJoin(destDir, name);                                 // lempar kalau tidak aman

          if (collected.length + 1 > limits.maxEntries) {
            throw new ZipRejected(`Zip berisi terlalu banyak entry (batas ${limits.maxEntries}).`);
          }
          const data = await readEntry(zf, e);
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
  const tops = new Set(collected.map((c) => topSegment(c.name)));
  const hasRootFile = collected.some((c) => !c.name.includes("/"));
  let strippedWrapper: string | null = null;

  if (tops.size === 1 && !hasRootFile) {
    strippedWrapper = [...tops][0];
    for (const c of collected) c.name = c.name.slice(strippedWrapper.length + 1);
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
```

- [ ] **Step 5: Jalankan test, pastikan LULUS**

Run: `npm test -- tests/intake.test.ts`
Expected: PASS (11 test)

- [ ] **Step 6: Commit**

```bash
git add lib/intake.ts tests/intake.test.ts tests/helpers/zip.ts
git commit -m "feat: extract zip aman dengan proteksi zip-slip dan strip wrapper dir"
```

---

### Task 4: Staging git repo

Alur yang membuat `deploy.sh` tidak perlu diubah sama sekali. Sudah diverifikasi empiris di spec §5.

**Files:**
- Create: `lib/staging.ts`, `tests/staging.test.ts`

**Interfaces:**
- Consumes: `normalizeProject` (Task 2), `extractZip` (Task 3)
- Produces: `prepareStaging(opts: { project: string; zip: Buffer; uploadsDir: string; limits: ZipLimits }): Promise<{ dir: string; extract: ExtractResult }>` — mengembalikan path staging repo yang siap dioper ke `deploy.sh`.

- [ ] **Step 1: Tulis test yang gagal**

`tests/staging.test.ts`:

```ts
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
```

- [ ] **Step 2: Jalankan test, pastikan GAGAL**

Run: `npm test -- tests/staging.test.ts`
Expected: FAIL — modul belum ada

- [ ] **Step 3: Implementasi `lib/staging.ts`**

```ts
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, cp, readdir } from "node:fs/promises";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractZip, type ExtractResult, type ZipLimits } from "./intake";

const exec = promisify(execFile);

// Identitas disuntik lewat -c supaya VPS1 tidak perlu `git config --global` apa pun.
const GIT_IDENTITY = [
  "-c", "user.email=deploy-monitor@localhost",
  "-c", "user.name=deploy-monitor",
];

const git = (dir: string, ...args: string[]) =>
  exec("git", ["-C", dir, ...GIT_IDENTITY, ...args], { maxBuffer: 32 * 1024 * 1024 });

export interface PrepareOpts {
  project: string;
  zip: Buffer;
  uploadsDir: string;
  limits: ZipLimits;
}

export async function prepareStaging(
  opts: PrepareOpts,
): Promise<{ dir: string; extract: ExtractResult }> {
  const dir = join(opts.uploadsDir, opts.project);

  // Extract ke temp DULU. Zip yang ditolak tidak boleh menyentuh staging repo
  // yang sudah berisi upload sebelumnya yang baik-baik saja.
  const staged = await mkdtemp(join(tmpdir(), "dm-extract-"));
  let extract: ExtractResult;
  try {
    extract = await extractZip(opts.zip, staged, opts.limits);

    await mkdir(dir, { recursive: true });
    await initRepo(dir);

    // Kosongkan isi kerja, sisakan .git — git yang mencatat penghapusannya.
    for (const name of await readdir(dir)) {
      if (name === ".git") continue;
      await rm(join(dir, name), { recursive: true, force: true });
    }
    await cp(staged, dir, { recursive: true });
  } finally {
    await rm(staged, { recursive: true, force: true });
  }

  await git(dir, "add", "-A");
  // --allow-empty WAJIB: tanpa ini, mengunggah zip yang sama persis membuat
  // `git commit` exit 1 dan deploy gagal sebelum sempat mulai.
  await git(dir, "commit", "--allow-empty", "-m", `upload ${new Date().toISOString()}`);

  return { dir, extract };
}

async function initRepo(dir: string): Promise<void> {
  try {
    await git(dir, "rev-parse", "--git-dir");
  } catch {
    // -b main memastikan HEAD -> refs/heads/main, yang jadi origin/HEAD setelah
    // deploy.sh meng-clone-nya — itulah yang dibaca deploy.sh:109.
    await exec("git", ["init", "-b", "main", dir]);
  }
}
```

- [ ] **Step 4: Jalankan test, pastikan LULUS**

Run: `npm test -- tests/staging.test.ts`
Expected: PASS (4 test)

- [ ] **Step 5: Commit**

```bash
git add lib/staging.ts tests/staging.test.ts
git commit -m "feat: staging git repo supaya deploy.sh menerima zip tanpa perubahan"
```

---

### Task 5: Validasi & serialisasi env override

**Files:**
- Create: `lib/envfile.ts`, `tests/envfile.test.ts`

**Interfaces:**
- Consumes: —
- Produces:
  - `parseDotenv(text: string): EnvPair[]` — untuk tombol "tempel .env" di UI
  - `validateEnv(pairs: EnvPair[]): EnvPair[]` — melempar `EnvInvalid` (field `key`, `reason`)
  - `serializeOverrides(pairs: EnvPair[]): string`
  - `DANGEROUS_KEYS: Set<string>`
  - tipe `EnvPair = { key: string; value: string }`

- [ ] **Step 1: Tulis test yang gagal**

`tests/envfile.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parseDotenv, validateEnv, serializeOverrides, DANGEROUS_KEYS } from "../lib/envfile";

describe("validateEnv", () => {
  it("menerima key yang sah", () => {
    expect(validateEnv([{ key: "SMTP_HOST", value: "x" }, { key: "_A1", value: "" }])).toHaveLength(2);
  });

  it("menolak key yang tidak sah", () => {
    for (const key of ["", "1ABC", "A-B", "A B", "A=B", "A.B", "A$B"]) {
      expect(() => validateEnv([{ key, value: "x" }])).toThrow();
    }
  });

  it("menolak nilai yang mengandung newline — env_file Docker tidak mendukungnya", () => {
    expect(() => validateEnv([{ key: "A", value: "baris1\nbaris2" }])).toThrow(/newline/i);
    expect(() => validateEnv([{ key: "A", value: "a\rb" }])).toThrow(/newline/i);
  });

  it("menolak key duplikat", () => {
    expect(() => validateEnv([{ key: "A", value: "1" }, { key: "A", value: "2" }])).toThrow(/duplikat/i);
  });

  it("men-trim spasi di awal/akhir nilai — parser env_file Docker tidak konsisten", () => {
    expect(validateEnv([{ key: "A", value: "  x  " }])[0].value).toBe("x");
  });

  it("mempertahankan karakter berbahaya apa adanya — nilai tidak pernah di-eval", () => {
    const v = "p@ss/w&rd$(whoami)`id`";
    expect(validateEnv([{ key: "A", value: v }])[0].value).toBe(v);
  });

  it("pesan error tidak pernah membocorkan nilai", () => {
    try {
      validateEnv([{ key: "1BAD", value: "SECRET_BOCOR" }]);
      throw new Error("seharusnya melempar");
    } catch (e) {
      expect(String((e as Error).message)).not.toContain("SECRET_BOCOR");
    }
  });
});

describe("parseDotenv", () => {
  it("mengurai format .env yang lazim", () => {
    expect(parseDotenv(`
# komentar
FOO=bar
export BAZ=qux
URL=postgres://u:p@h:5432/db?a=1&b=2
KOSONG=
    `)).toEqual([
      { key: "FOO", value: "bar" },
      { key: "BAZ", value: "qux" },
      { key: "URL", value: "postgres://u:p@h:5432/db?a=1&b=2" },
      { key: "KOSONG", value: "" },
    ]);
  });

  it("melepas kutip yang membungkus nilai", () => {
    expect(parseDotenv(`A="dikutip"\nB='tunggal'`)).toEqual([
      { key: "A", value: "dikutip" }, { key: "B", value: "tunggal" },
    ]);
  });
});

describe("serializeOverrides", () => {
  it("menulis KEY=VALUE literal, tanpa kutip", () => {
    expect(serializeOverrides([{ key: "A", value: "x y" }, { key: "B", value: "" }]))
      .toBe("A=x y\nB=\n");
  });
});

describe("DANGEROUS_KEYS", () => {
  it("menandai key yang membuat user ter-logout atau data tampak hilang", () => {
    expect(DANGEROUS_KEYS.has("BETTER_AUTH_SECRET")).toBe(true);
    expect(DANGEROUS_KEYS.has("NEXTAUTH_SECRET")).toBe(true);
    expect(DANGEROUS_KEYS.has("DATABASE_URL")).toBe(true);
  });
});
```

- [ ] **Step 2: Jalankan test, pastikan GAGAL**

Run: `npm test -- tests/envfile.test.ts`
Expected: FAIL — modul belum ada

- [ ] **Step 3: Implementasi `lib/envfile.ts`**

```ts
export interface EnvPair { key: string; value: string }

export class EnvInvalid extends Error {
  constructor(public key: string, public reason: string) {
    super(reason);            // TIDAK PERNAH menyertakan nilai — lihat Global Constraints
    this.name = "EnvInvalid";
  }
}

// Sekaligus membuat interpolasi key ke dalam regex grep di run.sh aman:
// tidak ada metakarakter regex yang bisa lolos.
const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Di-override = akibat yang mengagetkan. Diberi peringatan di UI, tidak diblokir. */
export const DANGEROUS_KEYS = new Set([
  "BETTER_AUTH_SECRET",  // DEPLOYMENT.md §4: semua session user langsung invalid
  "NEXTAUTH_SECRET",
  "SECRET_KEY",
  "SECRET_KEY_BASE",
  "APP_KEY",
  "DATABASE_URL",        // data lama tetap di /srv/data/<project>, tampak seperti hilang
]);

export function validateEnv(pairs: EnvPair[]): EnvPair[] {
  const seen = new Set<string>();
  const out: EnvPair[] = [];

  for (const p of pairs) {
    const key = p.key.trim();
    if (!KEY_RE.test(key)) {
      throw new EnvInvalid(
        key,
        `Nama env '${key}' tidak valid. Harus diawali huruf atau '_', lalu hanya huruf, angka, dan '_'.`,
      );
    }
    if (seen.has(key)) throw new EnvInvalid(key, `Env '${key}' ditulis lebih dari sekali (duplikat).`);
    seen.add(key);

    if (/[\r\n]/.test(p.value)) {
      throw new EnvInvalid(key, `Nilai '${key}' mengandung newline, yang tidak didukung env_file Docker.`);
    }
    out.push({ key, value: p.value.trim() });
  }
  return out;
}

export function parseDotenv(text: string): EnvPair[] {
  const out: EnvPair[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;

    const eq = line.indexOf("=");
    if (eq < 0) continue;

    const key = line.slice(0, eq).replace(/^export\s+/, "").trim();
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 && (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    )) {
      value = value.slice(1, -1);
    }
    out.push({ key, value });
  }
  return out;
}

/** Format yang dibaca run.sh: KEY=VALUE literal, satu per baris, tanpa kutip. */
export function serializeOverrides(pairs: EnvPair[]): string {
  return pairs.map((p) => `${p.key}=${p.value}\n`).join("");
}
```

- [ ] **Step 4: Jalankan test, pastikan LULUS**

Run: `npm test -- tests/envfile.test.ts`
Expected: PASS (11 test)

- [ ] **Step 5: Commit**

```bash
git add lib/envfile.ts tests/envfile.test.ts
git commit -m "feat: validasi dan serialisasi env override"
```

---

### Task 6: Parser ANSI

**Files:**
- Create: `lib/ansi.ts`, `tests/ansi.test.ts`

**Interfaces:**
- Consumes: —
- Produces: `parseAnsi(line: string): Span[]` di mana `Span = { text: string; color?: LogColor; bold?: boolean }` dan `LogColor = "red" | "green" | "yellow" | "blue" | "magenta" | "cyan"`.

- [ ] **Step 1: Tulis test yang gagal**

`tests/ansi.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parseAnsi } from "../lib/ansi";

const E = "";

describe("parseAnsi", () => {
  it("mengurai warna yang dipakai deploy.sh", () => {
    // info() di deploy.sh:33 -> CYAN
    expect(parseAnsi(`${E}[0;36mDetecting configuration...${E}[0m`))
      .toEqual([{ text: "Detecting configuration...", color: "cyan" }]);
    // success() -> GREEN
    expect(parseAnsi(`${E}[0;32mImage built.${E}[0m`))
      .toEqual([{ text: "Image built.", color: "green" }]);
    // warning() -> YELLOW dengan bold
    expect(parseAnsi(`${E}[1;33mFirst deploy.${E}[0m`))
      .toEqual([{ text: "First deploy.", color: "yellow", bold: true }]);
  });

  it("menangani beberapa segmen dalam satu baris", () => {
    expect(parseAnsi(`biasa ${E}[0;31mmerah${E}[0m lagi`)).toEqual([
      { text: "biasa " }, { text: "merah", color: "red" }, { text: " lagi" },
    ]);
  });

  it("meneruskan teks tanpa warna apa adanya", () => {
    expect(parseAnsi("Step 3/9 : RUN pnpm install")).toEqual([{ text: "Step 3/9 : RUN pnpm install" }]);
  });

  it("membuang escape non-warna dari output docker", () => {
    expect(parseAnsi(`${E}[2K${E}[1Gmembangun...`)).toEqual([{ text: "membangun..." }]);
  });

  it("tidak menghasilkan span kosong", () => {
    expect(parseAnsi(`${E}[0;32m${E}[0m`)).toEqual([]);
    expect(parseAnsi("")).toEqual([]);
  });
});
```

- [ ] **Step 2: Jalankan test, pastikan GAGAL**

Run: `npm test -- tests/ansi.test.ts`
Expected: FAIL — modul belum ada

- [ ] **Step 3: Implementasi `lib/ansi.ts`**

```ts
export type LogColor = "red" | "green" | "yellow" | "blue" | "magenta" | "cyan";
export interface Span { text: string; color?: LogColor; bold?: boolean }

const COLORS: Record<number, LogColor> = {
  31: "red", 32: "green", 33: "yellow", 34: "blue", 35: "magenta", 36: "cyan",
};

// Semua escape CSI. Yang berakhiran 'm' adalah SGR (warna); sisanya (gerakan
// kursor dari docker) dibuang.
const CSI = /\[([0-9;]*)([A-Za-z])/g;

export function parseAnsi(line: string): Span[] {
  const spans: Span[] = [];
  let color: LogColor | undefined;
  let bold = false;
  let last = 0;

  const push = (text: string) => {
    if (!text) return;
    spans.push({ text, ...(color && { color }), ...(bold && { bold }) });
  };

  for (const m of line.matchAll(CSI)) {
    push(line.slice(last, m.index));
    last = m.index + m[0].length;

    if (m[2] !== "m") continue;                    // bukan SGR: dibuang saja
    for (const p of (m[1] || "0").split(";")) {
      const n = Number(p);
      if (n === 0) { color = undefined; bold = false; }
      else if (n === 1) bold = true;
      else if (COLORS[n]) color = COLORS[n];
    }
  }
  push(line.slice(last));
  return spans;
}
```

- [ ] **Step 4: Jalankan test, pastikan LULUS**

Run: `npm test -- tests/ansi.test.ts`
Expected: PASS (5 test)

- [ ] **Step 5: Commit**

```bash
git add lib/ansi.ts tests/ansi.test.ts
git commit -m "feat: parser ANSI untuk warna log dari script"
```

---

### Task 7: Deteksi fase & ringkasan

**Files:**
- Create: `lib/phases.ts`, `tests/phases.test.ts`

**Interfaces:**
- Consumes: —
- Produces:
  - `PHASES: readonly Phase[]` dengan `Phase = { id: string; label: string }`
  - `detectPhase(plainLine: string): string | null`
  - `detectSummary(plainLine: string): Partial<Summary> | null` dengan `Summary = { sha: string; image: string; appPort: number }`
  - `stripAnsi(line: string): string`

- [ ] **Step 1: Tulis test yang gagal**

`tests/phases.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { detectPhase, detectSummary, stripAnsi, PHASES } from "../lib/phases";

describe("detectPhase", () => {
  it("mengenali penanda dari deploy.sh", () => {
    expect(detectPhase("Cloning repository...")).toBe("source");
    expect(detectPhase("Updating existing repository...")).toBe("source");
    expect(detectPhase("Detecting configuration...")).toBe("configure");
    expect(detectPhase("Building image...")).toBe("build");
    expect(detectPhase("Pushing image...")).toBe("push");
    expect(detectPhase("Shipping app config to runtime host...")).toBe("ship");
    expect(detectPhase("Triggering runtime deployment...")).toBe("runtime");
  });

  it("mengenali penanda dari run.sh", () => {
    expect(detectPhase("Running migration: pnpm migrate")).toBe("migrate");
    expect(detectPhase("Starting application...")).toBe("start");
    expect(detectPhase("Waiting for application...")).toBe("health");
  });

  it("mengabaikan baris biasa", () => {
    expect(detectPhase("Step 5/9 : RUN pnpm build")).toBeNull();
    expect(detectPhase("")).toBeNull();
  });

  it("setiap id yang dikembalikan ada di PHASES", () => {
    const ids = new Set(PHASES.map((p) => p.id));
    for (const line of ["Cloning repository...", "Building image...", "Waiting for application..."]) {
      expect(ids.has(detectPhase(line)!)).toBe(true);
    }
  });
});

describe("detectSummary", () => {
  it("mengambil commit dari deploy.sh:127", () => {
    expect(detectSummary("Commit: a1b2c3d")).toEqual({ sha: "a1b2c3d" });
  });

  it("mengambil image dan port dari blok penutup", () => {
    expect(detectSummary("Image  : 10.8.0.2:5000/kanban:a1b2c3d"))
      .toEqual({ image: "10.8.0.2:5000/kanban:a1b2c3d" });
    expect(detectSummary("Port    : 3000")).toEqual({ appPort: 3000 });
  });

  it("mengabaikan baris lain", () => {
    expect(detectSummary("Branch : main")).toBeNull();
    expect(detectSummary("random")).toBeNull();
  });
});

describe("stripAnsi", () => {
  it("membuang escape sebelum pencocokan", () => {
    expect(stripAnsi("[0;35mBuilding image...[0m")).toBe("Building image...");
  });
});
```

- [ ] **Step 2: Jalankan test, pastikan GAGAL**

Run: `npm test -- tests/phases.test.ts`
Expected: FAIL — modul belum ada

- [ ] **Step 3: Implementasi `lib/phases.ts`**

```ts
export interface Phase { id: string; label: string }

export const PHASES: readonly Phase[] = [
  { id: "source",    label: "Sumber" },
  { id: "configure", label: "Konfigurasi" },
  { id: "build",     label: "Build" },
  { id: "push",      label: "Push" },
  { id: "ship",      label: "Kirim Config" },
  { id: "runtime",   label: "Runtime" },
  { id: "migrate",   label: "Migrasi" },
  { id: "start",     label: "Start" },
  { id: "health",    label: "Health Check" },
] as const;

// PERINGATAN: ini string matching terhadap teks yang dicetak deploy.sh/run.sh.
// Sengaja dipakai karena murah, dan sengaja dibuat TIDAK menentukan apa pun yang
// penting: sukses/gagal SELALU dari exit code. Kalau satu penanda meleset,
// timeline-nya saja yang tidak maju — status deploy tetap benar.
const MARKERS: [RegExp, string][] = [
  [/^Cloning repository/,              "source"],
  [/^Updating existing repository/,    "source"],
  [/^Detecting configuration/,         "configure"],
  [/^Building image/,                  "build"],
  [/^Pushing image/,                   "push"],
  [/^Shipping app config/,             "ship"],
  [/^Triggering runtime deployment/,   "runtime"],
  [/^Running migration:/,              "migrate"],
  [/^Starting application/,            "start"],
  [/^Waiting for application/,         "health"],
];

export function stripAnsi(line: string): string {
  return line.replace(/\[[0-9;]*[A-Za-z]/g, "");
}

export function detectPhase(plainLine: string): string | null {
  const s = plainLine.trim();
  for (const [re, id] of MARKERS) if (re.test(s)) return id;
  return null;
}

export interface Summary { sha: string; image: string; appPort: number }

export function detectSummary(plainLine: string): Partial<Summary> | null {
  const s = plainLine.trim();

  const commit = /^Commit\s*:\s*(\S+)$/.exec(s);
  if (commit) return { sha: commit[1] };

  const image = /^Image\s*:\s*(\S+)$/.exec(s);
  if (image) return { image: image[1] };

  const port = /^Port\s*:\s*(\d+)$/.exec(s);
  if (port) return { appPort: Number(port[1]) };

  return null;
}
```

- [ ] **Step 4: Jalankan test, pastikan LULUS**

Run: `npm test -- tests/phases.test.ts`
Expected: PASS (6 test)

- [ ] **Step 5: Commit**

```bash
git add lib/phases.ts tests/phases.test.ts
git commit -m "feat: deteksi fase deploy dan ringkasan dari output script"
```

---

### Task 8: Database

**Files:**
- Create: `lib/db.ts`, `tests/db.test.ts`

**Interfaces:**
- Consumes: —
- Produces:
  - `openDb(path: string): Db`
  - `Db` dengan method: `createDeploy(d)`, `getDeploy(id)`, `listDeploys(limit)`, `appendLine(deployId, stream, text): number`, `getLines(deployId, afterSeq)`, `updateDeploy(id, patch)`, `markRunningAsInterrupted(): number`
  - tipe `DeployRow`, `LogRow`, `DeployStatus = "queued" | "running" | "success" | "failed" | "interrupted"`

- [ ] **Step 1: Tulis test yang gagal**

`tests/db.test.ts`:

```ts
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
    const raw = "[0;32mok[0m";
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
```

- [ ] **Step 2: Jalankan test, pastikan GAGAL**

Run: `npm test -- tests/db.test.ts`
Expected: FAIL — modul belum ada

- [ ] **Step 3: Implementasi `lib/db.ts`**

```ts
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type DeployStatus = "queued" | "running" | "success" | "failed" | "interrupted";

export interface DeployRow {
  id: string; project: string; status: DeployStatus; phase: string | null;
  created_at: number; started_at: number | null; ended_at: number | null;
  exit_code: number | null; sha: string | null; image: string | null;
  app_port: number | null; live_url: string | null;
  zip_name: string; zip_size: number; env_keys: string; error: string | null;
}

export interface LogRow { seq: number; stream: "stdout" | "stderr"; ts: number; text: string }

const SCHEMA = `
CREATE TABLE IF NOT EXISTS deploys (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  status TEXT NOT NULL,
  phase TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER, ended_at INTEGER, exit_code INTEGER,
  sha TEXT, image TEXT, app_port INTEGER, live_url TEXT,
  zip_name TEXT NOT NULL, zip_size INTEGER NOT NULL,
  env_keys TEXT NOT NULL DEFAULT '[]',
  error TEXT
);
CREATE TABLE IF NOT EXISTS log_lines (
  deploy_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  stream TEXT NOT NULL,
  ts INTEGER NOT NULL,
  text TEXT NOT NULL,
  PRIMARY KEY (deploy_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_deploys_created ON deploys(created_at DESC);
`;

const UPDATABLE = [
  "status", "phase", "started_at", "ended_at", "exit_code",
  "sha", "image", "app_port", "live_url", "error",
] as const;

export type DeployPatch = Partial<Pick<DeployRow, (typeof UPDATABLE)[number]>>;

export interface NewDeploy {
  id: string; project: string; zipName: string; zipSize: number; envKeys: string[];
}

export class Db {
  private seqs = new Map<string, number>();

  constructor(private sql: DatabaseSync) {}

  createDeploy(d: NewDeploy): void {
    this.sql.prepare(
      `INSERT INTO deploys (id, project, status, created_at, zip_name, zip_size, env_keys)
       VALUES (?, ?, 'queued', ?, ?, ?, ?)`,
    ).run(d.id, d.project, Date.now(), d.zipName, d.zipSize, JSON.stringify(d.envKeys));
  }

  getDeploy(id: string): DeployRow | undefined {
    return this.sql.prepare(`SELECT * FROM deploys WHERE id = ?`).get(id) as DeployRow | undefined;
  }

  listDeploys(limit: number): DeployRow[] {
    return this.sql.prepare(
      `SELECT * FROM deploys ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    ).all(limit) as unknown as DeployRow[];
  }

  updateDeploy(id: string, patch: DeployPatch): void {
    const keys = UPDATABLE.filter((k) => patch[k] !== undefined);
    if (keys.length === 0) return;
    this.sql.prepare(
      `UPDATE deploys SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`,
    ).run(...keys.map((k) => patch[k] as string | number), id);
  }

  appendLine(deployId: string, stream: "stdout" | "stderr", text: string): number {
    let seq = this.seqs.get(deployId);
    if (seq === undefined) {
      const row = this.sql.prepare(
        `SELECT COALESCE(MAX(seq), 0) AS m FROM log_lines WHERE deploy_id = ?`,
      ).get(deployId) as { m: number };
      seq = row.m;
    }
    seq += 1;
    this.seqs.set(deployId, seq);
    this.sql.prepare(
      `INSERT INTO log_lines (deploy_id, seq, stream, ts, text) VALUES (?, ?, ?, ?, ?)`,
    ).run(deployId, seq, stream, Date.now(), text);
    return seq;
  }

  getLines(deployId: string, afterSeq: number): LogRow[] {
    return this.sql.prepare(
      `SELECT seq, stream, ts, text FROM log_lines
       WHERE deploy_id = ? AND seq > ? ORDER BY seq ASC`,
    ).all(deployId, afterSeq) as unknown as LogRow[];
  }

  /** Dipanggil sekali saat boot. Deploy yang 'running' saat proses mati tidak
   *  akan pernah selesai — tanpa ini statusnya menggantung selamanya. */
  markRunningAsInterrupted(): number {
    const r = this.sql.prepare(
      `UPDATE deploys SET status = 'interrupted', ended_at = ?
       WHERE status IN ('running', 'queued')`,
    ).run(Date.now());
    return Number(r.changes);
  }
}

export function openDb(path: string): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const sql = new DatabaseSync(path);
  sql.exec("PRAGMA journal_mode = WAL");
  sql.exec(SCHEMA);
  return new Db(sql);
}
```

- [ ] **Step 4: Jalankan test, pastikan LULUS**

Run: `npm test -- tests/db.test.ts`
Expected: PASS (8 test)

- [ ] **Step 5: Commit**

```bash
git add lib/db.ts tests/db.test.ts
git commit -m "feat: penyimpanan SQLite untuk deploy dan log"
```

---

### Task 9: Executor

**Files:**
- Create: `lib/executor/types.ts`, `lib/executor/local.ts`, `lib/executor/ssh.ts`, `lib/executor/index.ts`, `tests/executor.local.test.ts`

**Interfaces:**
- Consumes: `Config` (Task 1)
- Produces: `Executor` dengan `run(cmd, args, opts): AsyncIterable<LogChunk>` di mana `LogChunk = { stream: "stdout" | "stderr"; line: string } | { stream: "exit"; code: number }`; dan `getExecutor(cfg: Config): Executor`.

- [ ] **Step 1: Tulis test yang gagal**

`tests/executor.local.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { LocalExecutor } from "../lib/executor/local";

const collect = async (it: AsyncIterable<{ stream: string; line?: string; code?: number }>) => {
  const out = []; for await (const c of it) out.push(c); return out;
};

describe("LocalExecutor", () => {
  const ex = new LocalExecutor();

  it("menyiarkan stdout baris demi baris", async () => {
    const got = await collect(ex.run("sh", ["-c", "echo satu; echo dua"], {}));
    expect(got.filter((c) => c.stream === "stdout").map((c) => c.line)).toEqual(["satu", "dua"]);
  });

  it("memisahkan stderr dari stdout", async () => {
    const got = await collect(ex.run("sh", ["-c", "echo keluar; echo salah >&2"], {}));
    expect(got.find((c) => c.stream === "stderr")?.line).toBe("salah");
  });

  it("mempertahankan escape ANSI apa adanya", async () => {
    const got = await collect(ex.run("printf", ["\\033[0;32mok\\033[0m\\n"], {}));
    expect(got[0].line).toBe("[0;32mok[0m");
  });

  it("mengirim exit code sebagai chunk terakhir", async () => {
    const got = await collect(ex.run("sh", ["-c", "exit 3"], {}));
    expect(got.at(-1)).toEqual({ stream: "exit", code: 3 });
  });

  it("melaporkan exit tidak nol untuk perintah yang tidak ada, bukan melempar", async () => {
    const got = await collect(ex.run("perintah-yang-tidak-ada-xyz", [], {}));
    expect(got.at(-1)!.stream).toBe("exit");
    expect(got.at(-1)!.code).not.toBe(0);
  });

  it("mengirimkan baris terakhir yang tidak diakhiri newline", async () => {
    const got = await collect(ex.run("printf", ["tanpa-newline"], {}));
    expect(got[0].line).toBe("tanpa-newline");
  });

  it("meneruskan env var", async () => {
    const got = await collect(ex.run("sh", ["-c", "echo $HALO"], { env: { HALO: "dunia" } }));
    expect(got[0].line).toBe("dunia");
  });
});
```

- [ ] **Step 2: Jalankan test, pastikan GAGAL**

Run: `npm test -- tests/executor.local.test.ts`
Expected: FAIL — modul belum ada

- [ ] **Step 3: Implementasi `lib/executor/types.ts`**

```ts
export type LogChunk =
  | { stream: "stdout" | "stderr"; line: string }
  | { stream: "exit"; code: number };

export interface RunOpts { env?: Record<string, string>; cwd?: string }

export interface Executor {
  run(cmd: string, args: string[], opts: RunOpts): AsyncIterable<LogChunk>;
  writeFile(path: string, data: string, mode: number): Promise<void>;
  remove(path: string): Promise<void>;
}
```

- [ ] **Step 4: Implementasi `lib/executor/local.ts`**

```ts
import { spawn } from "node:child_process";
import { writeFile, rm, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { Executor, LogChunk, RunOpts } from "./types";

export class LocalExecutor implements Executor {
  async *run(cmd: string, args: string[], opts: RunOpts): AsyncIterable<LogChunk> {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const queue: LogChunk[] = [];
    let notify: (() => void) | null = null;
    const wake = () => { notify?.(); notify = null; };
    const push = (c: LogChunk) => { queue.push(c); wake(); };

    // Buffer per-stream: sebuah chunk bisa terpotong di tengah baris.
    const buffers = { stdout: "", stderr: "" };
    const attach = (name: "stdout" | "stderr") => {
      child[name].setEncoding("utf8");
      child[name].on("data", (chunk: string) => {
        buffers[name] += chunk;
        const lines = buffers[name].split("\n");
        buffers[name] = lines.pop() ?? "";
        for (const line of lines) push({ stream: name, line });
      });
    };
    attach("stdout");
    attach("stderr");

    let done = false;
    const finish = (code: number) => {
      // Baris terakhir tanpa newline tetap harus terkirim.
      for (const name of ["stdout", "stderr"] as const) {
        if (buffers[name]) { push({ stream: name, line: buffers[name] }); buffers[name] = ""; }
      }
      push({ stream: "exit", code });
      done = true;
      wake();
    };

    child.on("close", (code) => finish(code ?? 1));
    // ENOENT dsb. dilaporkan sebagai exit tidak nol, bukan exception — pemanggil
    // hanya perlu menangani satu jenis kegagalan.
    child.on("error", (err) => { push({ stream: "stderr", line: String(err.message) }); finish(127); });

    while (!done || queue.length > 0) {
      if (queue.length === 0) { await new Promise<void>((r) => { notify = r; }); continue; }
      yield queue.shift()!;
    }
  }

  async writeFile(path: string, data: string, mode: number): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, data, { mode });
  }

  async remove(path: string): Promise<void> {
    await rm(path, { force: true });
  }
}
```

- [ ] **Step 5: Implementasi `lib/executor/ssh.ts`**

```ts
import { Client } from "ssh2";
import { readFileSync } from "node:fs";
import type { Executor, LogChunk, RunOpts } from "./types";

/**
 * HANYA untuk development dari laptop (spec D2). JANGAN dipakai produksi:
 * `deploy.sh` di sini adalah anak dari channel SSH, jadi blip jaringan mengirim
 * SIGHUP dan membunuh build di tengah jalan — mungkin saat migrasi. Produksi
 * memakai LocalExecutor di VPS1, di mana deploy tidak bergantung pada jaringan.
 */
export class SshExecutor implements Executor {
  constructor(private opts: { host: string; user: string; keyPath: string }) {}

  private connect(): Promise<Client> {
    return new Promise((res, rej) => {
      const c = new Client();
      c.on("ready", () => res(c)).on("error", rej).connect({
        host: this.opts.host,
        username: this.opts.user,
        privateKey: readFileSync(this.opts.keyPath),
      });
    });
  }

  async *run(cmd: string, args: string[], opts: RunOpts): AsyncIterable<LogChunk> {
    const conn = await this.connect();
    const prefix = Object.entries(opts.env ?? {})
      .map(([k, v]) => `${k}=${shq(v)} `).join("");
    const line = prefix + [cmd, ...args].map(shq).join(" ");

    const queue: LogChunk[] = [];
    let notify: (() => void) | null = null;
    const push = (c: LogChunk) => { queue.push(c); notify?.(); notify = null; };
    let done = false;

    const buffers = { stdout: "", stderr: "" };
    const feed = (name: "stdout" | "stderr", chunk: string) => {
      buffers[name] += chunk;
      const lines = buffers[name].split("\n");
      buffers[name] = lines.pop() ?? "";
      for (const l of lines) push({ stream: name, line: l });
    };

    await new Promise<void>((res, rej) => {
      conn.exec(line, (err, stream) => {
        if (err) return rej(err);
        stream.on("data", (d: Buffer) => feed("stdout", d.toString("utf8")));
        stream.stderr.on("data", (d: Buffer) => feed("stderr", d.toString("utf8")));
        stream.on("close", (code: number) => {
          for (const n of ["stdout", "stderr"] as const) {
            if (buffers[n]) push({ stream: n, line: buffers[n] });
          }
          push({ stream: "exit", code: code ?? 1 });
          done = true; notify?.(); notify = null;
          conn.end(); res();
        });
      });
    });

    while (!done || queue.length > 0) {
      if (queue.length === 0) { await new Promise<void>((r) => { notify = r; }); continue; }
      yield queue.shift()!;
    }
  }

  async writeFile(path: string, data: string, mode: number): Promise<void> {
    const conn = await this.connect();
    await new Promise<void>((res, rej) => {
      conn.sftp((err, sftp) => {
        if (err) return rej(err);
        sftp.writeFile(path, data, { mode }, (e) => { conn.end(); e ? rej(e) : res(); });
      });
    });
  }

  async remove(path: string): Promise<void> {
    for await (const c of this.run("rm", ["-f", path], {})) { void c; }
  }
}

function shq(s: string): string { return `'${s.replaceAll("'", `'\\''`)}'`; }
```

- [ ] **Step 6: Implementasi `lib/executor/index.ts`**

```ts
import type { Config } from "../config";
import type { Executor } from "./types";
import { LocalExecutor } from "./local";
import { SshExecutor } from "./ssh";

export type { Executor, LogChunk, RunOpts } from "./types";

export function getExecutor(cfg: Config): Executor {
  if (cfg.executor === "ssh") {
    if (!cfg.ssh) throw new Error("EXECUTOR=ssh tapi konfigurasi SSH tidak lengkap.");
    return new SshExecutor(cfg.ssh);
  }
  return new LocalExecutor();
}
```

- [ ] **Step 7: Jalankan test, pastikan LULUS**

Run: `npm test -- tests/executor.local.test.ts`
Expected: PASS (7 test)

- [ ] **Step 8: Commit**

```bash
git add lib/executor tests/executor.local.test.ts
git commit -m "feat: abstraksi Executor dengan implementasi local dan ssh"
```

---

### Task 10: Runner — antrian & orkestrasi

Jantung aplikasi. Diuji dengan `deploy.sh` **palsu**, jadi seluruh test suite jalan tanpa docker dan tanpa VPS.

**Files:**
- Create: `lib/bus.ts`, `lib/runner.ts`, `tests/runner.test.ts`, `tests/fixtures/fake-deploy.sh`

**Interfaces:**
- Consumes: semua modul sebelumnya
- Produces: `Runner` dengan `enqueue(job: DeployJob): Promise<string>` (mengembalikan deploy id) dan `waitForIdle(): Promise<void>` (khusus test); `DeployJob = { project: string; zip: Buffer; zipName: string; env: EnvPair[] }`.

- [ ] **Step 1: Buat fixture `deploy.sh` palsu**

`tests/fixtures/fake-deploy.sh` (jangan lupa `chmod +x`):

```bash
#!/usr/bin/env bash
# deploy.sh palsu: mencetak penanda fase yang sama dengan yang asli, berwarna,
# lalu keluar dengan FAKE_EXIT. Membuat test runner tidak butuh docker/VPS.
set -u
CYAN='\033[0;36m'; GREEN='\033[0;32m'; MAGENTA='\033[0;35m'; RESET='\033[0m'

echo -e "${CYAN}Cloning repository...${RESET}"
echo -e "${CYAN}Detecting configuration...${RESET}"
echo "Commit: deadbee"
echo -e "${MAGENTA}Building image...${RESET}"
echo "Step 1/5 : FROM node:22-alpine"
[ -n "${ENV_OVERRIDES_FILE:-}" ] && echo "OVERRIDES_SEEN=${ENV_OVERRIDES_FILE}"
echo -e "${MAGENTA}Pushing image...${RESET}"
echo -e "${MAGENTA}Triggering runtime deployment...${RESET}"
echo -e "${MAGENTA}Starting application...${RESET}"
echo "gagal-di-stderr" >&2
echo "Image  : 10.8.0.2:5000/app:deadbee"
echo "Port    : 3000"
echo -e "${GREEN}Deployment completed.${RESET}"
exit "${FAKE_EXIT:-0}"
```

- [ ] **Step 2: Implementasi `lib/bus.ts`**

```ts
import { EventEmitter } from "node:events";

export interface LineEvent { deployId: string; seq: number; stream: string; ts: number; text: string }
export interface StateEvent { deployId: string }

class Bus extends EventEmitter {
  emitLine(e: LineEvent) { this.emit(`line:${e.deployId}`, e); }
  emitState(e: StateEvent) { this.emit(`state:${e.deployId}`, e); }
}

// Satu instans per proses. SSE fan-out dilakukan di sini, bukan lewat polling DB.
export const bus = new Bus();
bus.setMaxListeners(0);
```

- [ ] **Step 3: Tulis test yang gagal**

`tests/runner.test.ts`:

```ts
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
    expect(db.getLines(id, 0).some((l) => l.text.includes("["))).toBe(true);
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
```

- [ ] **Step 4: Jalankan test, pastikan GAGAL**

Run: `chmod +x tests/fixtures/fake-deploy.sh && npm test -- tests/runner.test.ts`
Expected: FAIL — modul belum ada

- [ ] **Step 5: Implementasi `lib/runner.ts`**

```ts
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Db } from "./db";
import type { Executor } from "./executor";
import { bus } from "./bus";
import { prepareStaging } from "./staging";
import { serializeOverrides, type EnvPair } from "./envfile";
import { detectPhase, detectSummary, stripAnsi } from "./phases";
import type { ZipLimits } from "./intake";

export interface DeployJob { project: string; zip: Buffer; zipName: string; env: EnvPair[] }

export interface RunnerOpts {
  db: Db;
  executor: Executor;
  deploySh: string;
  uploadsDir: string;
  publicHost: string;
  limits: ZipLimits;
  extraEnv?: Record<string, string>;
}

export class Runner {
  private queue: { id: string; job: DeployJob }[] = [];
  private active = false;
  private idle: Promise<void> = Promise.resolve();

  constructor(private o: RunnerOpts) {}

  async enqueue(job: DeployJob): Promise<string> {
    const id = randomUUID();
    this.o.db.createDeploy({
      id,
      project: job.project,
      zipName: job.zipName,
      zipSize: job.zip.length,
      envKeys: job.env.map((e) => e.key),   // NAMA saja — spec D7
    });
    this.queue.push({ id, job });
    bus.emitState({ deployId: id });
    this.pump();
    return id;
  }

  /** Khusus test. Produksi tidak pernah menunggu antrian kosong. */
  waitForIdle(): Promise<void> { return this.idle; }

  private pump(): void {
    if (this.active) return;
    this.active = true;
    this.idle = (async () => {
      while (this.queue.length > 0) {
        const next = this.queue.shift()!;
        await this.execute(next.id, next.job);
      }
      this.active = false;
    })();
  }

  private async execute(id: string, job: DeployJob): Promise<void> {
    const { db } = this.o;
    db.updateDeploy(id, { status: "running", started_at: Date.now() });
    bus.emitState({ deployId: id });

    const say = (stream: "stdout" | "stderr", text: string) => {
      const seq = db.appendLine(id, stream, text);
      bus.emitLine({ deployId: id, seq, stream, ts: Date.now(), text });
      return seq;
    };

    let overridePath: string | null = null;

    try {
      const { dir, extract } = await prepareStaging({
        project: job.project, zip: job.zip,
        uploadsDir: this.o.uploadsDir, limits: this.o.limits,
      });
      say("stdout", `[0;36mMenerima ${extract.fileCount} file dari ${job.zipName}.[0m`);
      if (extract.strippedWrapper) {
        say("stdout", `[0;36mMelepas direktori pembungkus '${extract.strippedWrapper}'.[0m`);
      }

      const env: Record<string, string> = { ...this.o.extraEnv };
      if (job.env.length > 0) {
        overridePath = join(dir, ".env-overrides");
        await this.o.executor.writeFile(overridePath, serializeOverrides(job.env), 0o600);
        env.ENV_OVERRIDES_FILE = overridePath;
        // Nama key saja. Nilai tidak boleh pernah masuk log.
        say("stdout", `[0;36mEnv override: ${job.env.map((e) => e.key).join(", ")}[0m`);
      }

      const summary: { sha?: string; image?: string; appPort?: number } = {};
      let phase: string | null = null;
      let exitCode = 1;

      for await (const chunk of this.o.executor.run(this.o.deploySh, [dir], { env })) {
        if (chunk.stream === "exit") { exitCode = chunk.code; break; }

        say(chunk.stream, chunk.line);

        const plain = stripAnsi(chunk.line);
        const p = detectPhase(plain);
        if (p && p !== phase) {
          phase = p;
          db.updateDeploy(id, { phase });
          bus.emitState({ deployId: id });
        }
        Object.assign(summary, detectSummary(plain) ?? {});
      }

      const liveUrl = this.o.publicHost && summary.appPort
        ? `http://${this.o.publicHost}:${summary.appPort}`
        : null;

      // Status SELALU dari exit code — tidak pernah dari teks log.
      db.updateDeploy(id, {
        status: exitCode === 0 ? "success" : "failed",
        exit_code: exitCode,
        ended_at: Date.now(),
        sha: summary.sha ?? null,
        image: summary.image ?? null,
        app_port: summary.appPort ?? null,
        live_url: liveUrl,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      say("stderr", `[0;31m${message}[0m`);
      db.updateDeploy(id, { status: "failed", error: message, ended_at: Date.now() });
    } finally {
      // Sukses maupun gagal, secret tidak boleh tertinggal di disk.
      if (overridePath) {
        await this.o.executor.remove(overridePath).catch(() => {});
      }
      bus.emitState({ deployId: id });
    }
  }
}
```

- [ ] **Step 6: Jalankan test, pastikan LULUS**

Run: `npm test -- tests/runner.test.ts`
Expected: PASS (9 test)

- [ ] **Step 7: Jalankan SELURUH test suite**

Run: `npm test`
Expected: PASS semuanya

- [ ] **Step 8: Commit**

```bash
git add lib/runner.ts lib/bus.ts tests/runner.test.ts tests/fixtures/fake-deploy.sh
git commit -m "feat: runner dengan antrian serial, deteksi fase, dan penanganan env override"
```

---

### Task 11: Patch `deploy.sh` dan `run.sh`

**Files:**
- Modify: `deploy/deploy.sh` (sekitar baris 386-394)
- Modify: `deploy/run.sh` (sekitar baris 140)
- Create: `tests/scripts/env-override.test.sh`

**Interfaces:**
- Consumes: `ENV_OVERRIDES_FILE` (env var, dikirim Runner dari Task 10)
- Produces: file `app.env.override` di `/srv/apps/<project>/` pada VPS2, dikonsumsi & dihapus `run.sh`

- [ ] **Step 1: Tulis test bash yang gagal**

`tests/scripts/env-override.test.sh` — menguji `env_set` secara terisolasi:

```bash
#!/usr/bin/env bash
# Menguji semantik upsert app.env dari run.sh tanpa butuh docker atau VPS.
set -uo pipefail
FAIL=0
check() { if [ "$2" = "$3" ]; then echo "  ok   $1"; else echo "  FAIL $1: '$2' != '$3'"; FAIL=1; fi; }

WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
APP_DIR="$WORK/apps/app"; mkdir -p "$APP_DIR"
export APP_DIR
APP_ENV_FILE="$APP_DIR/app.env"

cat > "$APP_ENV_FILE" <<'EOF'
DATABASE_URL=file:/app/data/prod.db
BETTER_AUTH_SECRET=RAHASIA_LAMA
ADMIN_EMAIL=lama@x.com
export LEGACY=1
EOF
chmod 600 "$APP_ENV_FILE"

cat > "$APP_DIR/app.env.override" <<'EOF'
ADMIN_EMAIL=baru@x.com
SMTP_PASS=p@ss/w&rd$(whoami)`id`
CONN=postgres://u:p@h:5432/db?a=1&b=2
EOF

# Ambil fungsi + blok override langsung dari run.sh yang sebenarnya.
eval "$(sed -n '/^env_set()/,/^}/p' "$(dirname "$0")/../../deploy/run.sh")"
eval "$(sed -n '/^apply_env_overrides()/,/^}/p' "$(dirname "$0")/../../deploy/run.sh")"
apply_env_overrides >/dev/null

get() { grep -m1 "^$1=" "$APP_ENV_FILE" | cut -d= -f2-; }

check "key yang di-override berubah"          "$(get ADMIN_EMAIL)"        "baru@x.com"
check "key yang tidak disebut tetap utuh"     "$(get BETTER_AUTH_SECRET)" "RAHASIA_LAMA"
check "DATABASE_URL tetap utuh"               "$(get DATABASE_URL)"       "file:/app/data/prod.db"
check "nilai berbahaya tersimpan literal"     "$(get SMTP_PASS)"          'p@ss/w&rd$(whoami)`id`'
check "nilai berisi = dan & utuh"             "$(get CONN)"               "postgres://u:p@h:5432/db?a=1&b=2"
check "format export dipertahankan"           "$(grep -c '^export LEGACY=1$' "$APP_ENV_FILE")" "1"
check "tidak ada key duplikat"                "$(grep -c '^ADMIN_EMAIL=' "$APP_ENV_FILE")" "1"
check "perms tetap 600"                       "$(stat -c %a "$APP_ENV_FILE" 2>/dev/null || stat -f %Lp "$APP_ENV_FILE")" "600"
check "file override dihapus"                 "$([ -f "$APP_DIR/app.env.override" ] && echo ada || echo hilang)" "hilang"

[ "$FAIL" -eq 0 ] && echo "SEMUA LULUS" || echo "ADA YANG GAGAL"
exit "$FAIL"
```

- [ ] **Step 2: Jalankan test, pastikan GAGAL**

Run: `chmod +x tests/scripts/env-override.test.sh && ./tests/scripts/env-override.test.sh`
Expected: FAIL — `env_set` belum ada di `run.sh`

- [ ] **Step 3: Tambahkan `env_set` dan `apply_env_overrides` ke `deploy/run.sh`**

Sisipkan **tepat sebelum** baris `ADDED=""` (sekitar baris 140), yaitu sesudah `chmod 600 "${APP_ENV_FILE}"`:

```bash
# ------------------------------------------------------------------
# 2b. Env override dari deploy-monitor (opsional)
# ------------------------------------------------------------------
# Berbeda dari env_add di bawah: ini MENIMPA nilai yang sudah ada. Dijalankan
# LEBIH DULU supaya autofill sesudahnya melihat key ini sudah terisi dan tidak
# menyentuhnya — khususnya gen_secret(), yang tidak akan pernah jalan untuk key
# yang diisi sendiri oleh user.
env_set() {
  local tmp; tmp="$(mktemp)"
  grep -vE "^[[:space:]]*(export[[:space:]]+)?$1=" "${APP_ENV_FILE}" > "${tmp}" 2>/dev/null || true
  printf '%s=%s\n' "$1" "$2" >> "${tmp}"
  # cat, bukan mv: menjaga mode 600 dan inode file aslinya.
  cat "${tmp}" > "${APP_ENV_FILE}"
  rm -f "${tmp}"
}

apply_env_overrides() {
  local file="${APP_DIR}/app.env.override"
  [ -f "${file}" ] || return 0

  local applied="" line key value
  while IFS= read -r line || [ -n "${line}" ]; do
    case "${line}" in ''|'#'*) continue ;; esac
    case "${line}" in *=*) ;; *) continue ;; esac

    key="${line%%=*}"
    value="${line#*=}"
    # Nilai TIDAK PERNAH di-eval; hanya dipotong sebagai string.
    case "${key}" in ''|[0-9]*|*[!A-Za-z0-9_]*) continue ;; esac

    env_set "${key}" "${value}"
    applied="${applied}${applied:+, }${key}"
  done < "${file}"

  # Secret tidak boleh tertinggal di disk setelah dipakai.
  rm -f "${file}"

  # Nama key saja — mencetak nilainya akan membocorkan secret ke log deploy.
  [ -n "${applied}" ] && info "app.env: overrode ${applied}"
  return 0
}

apply_env_overrides
```

- [ ] **Step 4: Jalankan test bash, pastikan LULUS**

Run: `./tests/scripts/env-override.test.sh`
Expected: `SEMUA LULUS` (9 check)

- [ ] **Step 5: Tambahkan pengiriman override ke `deploy/deploy.sh`**

Sisipkan **tepat sesudah** baris `success "Config shipped."` (sekitar baris 394):

```bash
# Opsional: env override dari deploy-monitor. Tanpa ENV_OVERRIDES_FILE, blok ini
# tidak melakukan apa pun dan deploy.sh berperilaku persis seperti sebelumnya —
# pemakaian manual dari console tidak terpengaruh.
if [ -n "${ENV_OVERRIDES_FILE:-}" ] && [ -s "${ENV_OVERRIDES_FILE}" ]; then
  action "Shipping env overrides..."
  scp "${SSH_OPTS[@]}" "${ENV_OVERRIDES_FILE}" \
    "${RUNTIME_USER}@${RUNTIME_HOST}:${RUNTIME_APPS_DIR}/${PROJECT}/app.env.override"
  success "Env overrides shipped."
fi
```

- [ ] **Step 6: Periksa sintaks kedua script**

Run: `bash -n deploy/deploy.sh && bash -n deploy/run.sh && echo "sintaks OK"`
Expected: `sintaks OK`

- [ ] **Step 7: Pastikan alur tanpa override tidak berubah**

Run: `grep -c 'ENV_OVERRIDES_FILE' deploy/deploy.sh`
Expected: `2` — hanya di dalam blok bersyarat, tidak ada di jalur utama

- [ ] **Step 8: Commit**

```bash
git add deploy/deploy.sh deploy/run.sh tests/scripts/env-override.test.sh
git commit -m "feat: env override per-key dari deploy-monitor ke app.env"
```

---

### Task 12: Auth dan API deploy

**Files:**
- Create: `lib/auth.ts`, `lib/server.ts`, `app/api/auth/login/route.ts`, `app/api/deploys/route.ts`, `app/api/deploys/[id]/route.ts`, `app/api/deploys/[id]/logs/route.ts`, `tests/auth.test.ts`

**Interfaces:**
- Consumes: `Runner` (Task 10), `Db` (Task 8), `getConfig` (Task 1), `validateEnv`/`parseDotenv` (Task 5), `normalizeProject` (Task 2)
- Produces: `getServer(): { db: Db; runner: Runner; cfg: Config }` (singleton per proses); `requireAuth(req): Response | null`; `COOKIE_NAME = "dm_token"`

- [ ] **Step 1: Tulis test yang gagal**

`tests/auth.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { tokenMatches } from "../lib/auth";

describe("tokenMatches", () => {
  it("menerima token yang benar", () => {
    expect(tokenMatches("rahasia", "rahasia")).toBe(true);
  });
  it("menolak yang salah, termasuk panjang berbeda", () => {
    expect(tokenMatches("rahasia", "salah")).toBe(false);
    expect(tokenMatches("rahasia", "rahasia1")).toBe(false);
    expect(tokenMatches("rahasia", "")).toBe(false);
  });
});
```

- [ ] **Step 2: Jalankan test, pastikan GAGAL**

Run: `npm test -- tests/auth.test.ts`
Expected: FAIL — modul belum ada

- [ ] **Step 3: Implementasi `lib/auth.ts`**

```ts
import { timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { getConfig } from "./config";

export const COOKIE_NAME = "dm_token";

/** Perbandingan waktu-tetap, supaya token tidak bisa ditebak byte demi byte. */
export function tokenMatches(expected: string, given: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(given, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function isAuthed(): Promise<boolean> {
  const jar = await cookies();
  const given = jar.get(COOKIE_NAME)?.value ?? "";
  return tokenMatches(getConfig().monitorToken, given);
}

export async function requireAuth(): Promise<Response | null> {
  if (await isAuthed()) return null;
  return Response.json({ error: "Tidak terautentikasi." }, { status: 401 });
}
```

- [ ] **Step 4: Implementasi `lib/server.ts`**

```ts
import { getConfig } from "./config";
import { openDb, type Db } from "./db";
import { getExecutor } from "./executor";
import { Runner } from "./runner";

let singleton: { db: Db; runner: Runner } | undefined;

export function getServer() {
  const cfg = getConfig();
  if (!singleton) {
    const db = openDb(cfg.dbPath);
    // Deploy yang sedang berjalan saat proses mati tidak akan pernah selesai.
    const orphans = db.markRunningAsInterrupted();
    if (orphans > 0) console.warn(`[monitor] ${orphans} deploy yatim ditandai interrupted.`);

    singleton = {
      db,
      runner: new Runner({
        db,
        executor: getExecutor(cfg),
        deploySh: cfg.deploySh,
        uploadsDir: cfg.uploadsDir,
        publicHost: cfg.publicHost,
        limits: { maxTotalBytes: cfg.maxZipBytes, maxEntries: 20000 },
      }),
    };
  }
  return { ...singleton, cfg };
}
```

- [ ] **Step 5: Implementasi `app/api/auth/login/route.ts`**

```ts
import { cookies } from "next/headers";
import { getConfig } from "@/lib/config";
import { COOKIE_NAME, tokenMatches } from "@/lib/auth";

export async function POST(req: Request) {
  const { token } = (await req.json()) as { token?: string };
  if (!token || !tokenMatches(getConfig().monitorToken, token)) {
    return Response.json({ error: "Token salah." }, { status: 401 });
  }
  const jar = await cookies();
  jar.set(COOKIE_NAME, token, {
    httpOnly: true, sameSite: "lax", path: "/", maxAge: 60 * 60 * 24 * 30,
  });
  return Response.json({ ok: true });
}
```

- [ ] **Step 6: Implementasi `app/api/deploys/route.ts`**

```ts
import { requireAuth } from "@/lib/auth";
import { getServer } from "@/lib/server";
import { normalizeProject } from "@/lib/project";
import { validateEnv, EnvInvalid, type EnvPair } from "@/lib/envfile";

export const dynamic = "force-dynamic";

export async function GET() {
  const denied = await requireAuth();
  if (denied) return denied;
  return Response.json({ deploys: getServer().db.listDeploys(50) });
}

export async function POST(req: Request) {
  const denied = await requireAuth();
  if (denied) return denied;

  const { runner, cfg } = getServer();
  const form = await req.formData();

  const file = form.get("zip");
  if (!(file instanceof File)) {
    return Response.json({ error: "File zip wajib diunggah." }, { status: 400 });
  }
  if (file.size > cfg.maxZipBytes) {
    return Response.json(
      { error: `Zip terlalu besar (${file.size} byte, batas ${cfg.maxZipBytes}).` },
      { status: 400 },
    );
  }

  let project: string;
  try {
    project = normalizeProject(String(form.get("project") ?? ""));
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }

  let env: EnvPair[];
  try {
    env = validateEnv(JSON.parse(String(form.get("env") ?? "[]")) as EnvPair[]);
  } catch (e) {
    // EnvInvalid tidak pernah memuat nilai — aman dikirim ke klien.
    const message = e instanceof EnvInvalid ? e.message : "Format env tidak valid.";
    return Response.json({ error: message }, { status: 400 });
  }

  const id = await runner.enqueue({
    project,
    zip: Buffer.from(await file.arrayBuffer()),
    zipName: file.name,
    env,
  });

  return Response.json({ id, project }, { status: 202 });
}
```

- [ ] **Step 7: Implementasi `app/api/deploys/[id]/route.ts`**

```ts
import { requireAuth } from "@/lib/auth";
import { getServer } from "@/lib/server";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const denied = await requireAuth();
  if (denied) return denied;

  const { id } = await ctx.params;
  const deploy = getServer().db.getDeploy(id);
  if (!deploy) return Response.json({ error: "Deploy tidak ditemukan." }, { status: 404 });
  return Response.json({ deploy });
}
```

- [ ] **Step 8: Implementasi `app/api/deploys/[id]/logs/route.ts`**

```ts
import { requireAuth } from "@/lib/auth";
import { getServer } from "@/lib/server";
import { stripAnsi } from "@/lib/phases";

export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const denied = await requireAuth();
  if (denied) return denied;

  const { id } = await ctx.params;
  const plain = new URL(req.url).searchParams.get("plain") === "1";
  const lines = getServer().db.getLines(id, 0);

  const body = lines.map((l) => (plain ? stripAnsi(l.text) : l.text)).join("\n");
  return new Response(body, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "content-disposition": `attachment; filename="deploy-${id}.log"`,
    },
  });
}
```

- [ ] **Step 9: Jalankan test dan build**

Run: `npm test -- tests/auth.test.ts && npx tsc --noEmit`
Expected: PASS, tanpa error TypeScript

- [ ] **Step 10: Commit**

```bash
git add lib/auth.ts lib/server.ts app/api tests/auth.test.ts
git commit -m "feat: auth token dan API deploy"
```

---

### Task 13: Streaming SSE

**Files:**
- Create: `app/api/deploys/[id]/stream/route.ts`

**Interfaces:**
- Consumes: `bus` (Task 10), `Db` (Task 8)
- Produces: endpoint SSE yang mengirim event `line` (`{seq, stream, text}`) dan `state` (`{deploy}`), menghormati header `Last-Event-ID`

- [ ] **Step 1: Implementasi route**

```ts
import { requireAuth } from "@/lib/auth";
import { getServer } from "@/lib/server";
import { bus, type LineEvent } from "@/lib/bus";

export const dynamic = "force-dynamic";

const TERMINAL = new Set(["success", "failed", "interrupted"]);

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const denied = await requireAuth();
  if (denied) return denied;

  const { id } = await ctx.params;
  const { db } = getServer();
  if (!db.getDeploy(id)) return Response.json({ error: "Deploy tidak ditemukan." }, { status: 404 });

  // Reconnect: browser mengirim balik id event terakhir yang diterimanya, jadi
  // refresh di tengah build tidak kehilangan satu baris pun.
  const resume = Number(req.headers.get("last-event-id") ?? 0) || 0;

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      const send = (event: string, data: unknown, eventId?: number) => {
        if (closed) return;
        const idLine = eventId === undefined ? "" : `id: ${eventId}\n`;
        controller.enqueue(encoder.encode(`${idLine}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };

      // 1. Putar ulang dari database dulu.
      for (const l of db.getLines(id, resume)) {
        send("line", { seq: l.seq, stream: l.stream, text: l.text }, l.seq);
      }
      send("state", { deploy: db.getDeploy(id) });

      const onLine = (e: LineEvent) => send("line", { seq: e.seq, stream: e.stream, text: e.text }, e.seq);
      const onState = () => {
        const d = db.getDeploy(id);
        send("state", { deploy: d });
        if (d && TERMINAL.has(d.status)) finish();
      };

      // 2. Baru menyambung ke siaran langsung.
      bus.on(`line:${id}`, onLine);
      bus.on(`state:${id}`, onState);

      // Proxy memutus koneksi yang diam; komentar SSE menahannya tetap hidup.
      const ping = setInterval(() => { if (!closed) controller.enqueue(encoder.encode(": ping\n\n")); }, 20000);

      const finish = () => {
        if (closed) return;
        closed = true;
        clearInterval(ping);
        bus.off(`line:${id}`, onLine);
        bus.off(`state:${id}`, onState);
        try { controller.close(); } catch { /* sudah tertutup */ }
      };

      req.signal.addEventListener("abort", finish);

      const current = db.getDeploy(id);
      if (current && TERMINAL.has(current.status)) finish();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",   // matikan buffering nginx kalau ada di depan
    },
  });
}
```

- [ ] **Step 2: Verifikasi tipe**

Run: `npx tsc --noEmit`
Expected: tanpa error

- [ ] **Step 3: Commit**

```bash
git add app/api/deploys/\[id\]/stream/route.ts
git commit -m "feat: streaming log realtime lewat SSE dengan replay saat reconnect"
```

---

### Task 14: Frontend — kerangka, login, dan dashboard

**Files:**
- Create: `app/login/page.tsx`, `app/page.tsx` (ganti), `components/DeployList.tsx`, `components/UploadForm.tsx`, `components/EnvEditor.tsx`, `lib/format.ts`
- Modify: `app/layout.tsx`, `app/globals.css`

**Interfaces:**
- Consumes: API dari Task 12
- Produces: komponen `DeployList`, `UploadForm`, `EnvEditor`; helper `formatRelative(ts)`, `formatDuration(ms)`, `STATUS_STYLE`

- [ ] **Step 1: Definisikan token warna di `app/globals.css`**

Ganti seluruh isinya:

```css
@import "tailwindcss";

:root {
  --bg: #08090c;
  --panel: #0e1015;
  --panel-2: #14171f;
  --border: #23262f;
  --text: #e7e9ee;
  --muted: #8b90a0;
  --accent: #4f8cff;

  --log-red: #ff6b6b;
  --log-green: #4ade80;
  --log-yellow: #fbbf24;
  --log-blue: #60a5fa;
  --log-magenta: #c084fc;
  --log-cyan: #22d3ee;
}

html, body {
  background: var(--bg);
  color: var(--text);
  color-scheme: dark;
}

body {
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  -webkit-font-smoothing: antialiased;
}
```

- [ ] **Step 2: Implementasi `lib/format.ts`**

```ts
export function formatRelative(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s} detik lalu`;
  if (s < 3600) return `${Math.floor(s / 60)} menit lalu`;
  if (s < 86400) return `${Math.floor(s / 3600)} jam lalu`;
  return `${Math.floor(s / 86400)} hari lalu`;
}

export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}d` : `${Math.floor(s / 60)}m ${s % 60}d`;
}

export const STATUS_STYLE: Record<string, { label: string; dot: string; text: string }> = {
  queued:      { label: "Antri",    dot: "bg-slate-500",  text: "text-slate-400" },
  running:     { label: "Berjalan", dot: "bg-sky-400 animate-pulse", text: "text-sky-300" },
  success:     { label: "Sukses",   dot: "bg-emerald-400", text: "text-emerald-300" },
  failed:      { label: "Gagal",    dot: "bg-rose-500",   text: "text-rose-300" },
  interrupted: { label: "Terputus", dot: "bg-amber-400",  text: "text-amber-300" },
};
```

- [ ] **Step 3: Implementasi `app/login/page.tsx`**

```tsx
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function LoginPage() {
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
    setBusy(false);
    if (res.ok) router.push("/");
    else setError("Token salah.");
  }

  return (
    <main className="grid min-h-screen place-items-center p-6">
      <form onSubmit={submit} className="w-full max-w-sm space-y-4">
        <div>
          <h1 className="text-lg font-semibold">Deploy Monitor</h1>
          <p className="mt-1 text-sm text-[var(--muted)]">Masukkan token akses.</p>
        </div>
        <input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="MONITOR_TOKEN"
          autoFocus
          className="w-full rounded-lg border border-[var(--border)] bg-[var(--panel)] px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
        />
        {error && <p className="text-sm text-rose-400">{error}</p>}
        <button
          disabled={busy || !token}
          className="w-full rounded-lg bg-[var(--accent)] px-3 py-2 text-sm font-medium text-white disabled:opacity-40"
        >
          {busy ? "Memeriksa…" : "Masuk"}
        </button>
      </form>
    </main>
  );
}
```

- [ ] **Step 4: Implementasi `components/EnvEditor.tsx`**

```tsx
"use client";

import { useState } from "react";
import { DANGEROUS_KEYS, parseDotenv, type EnvPair } from "@/lib/envfile";

export function EnvEditor({ value, onChange }: { value: EnvPair[]; onChange: (v: EnvPair[]) => void }) {
  const [paste, setPaste] = useState("");

  const set = (i: number, patch: Partial<EnvPair>) =>
    onChange(value.map((p, j) => (j === i ? { ...p, ...patch } : p)));

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <label className="text-sm font-medium">Environment variable</label>
        <span className="text-xs text-[var(--muted)]">
          Menimpa per-key. Yang tidak diisi tidak tersentuh.
        </span>
      </div>

      {value.map((pair, i) => (
        <div key={i} className="space-y-1">
          <div className="flex gap-2">
            <input
              value={pair.key}
              onChange={(e) => set(i, { key: e.target.value })}
              placeholder="NAMA_KEY"
              className="w-2/5 rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1.5 font-mono text-xs outline-none focus:border-[var(--accent)]"
            />
            <input
              value={pair.value}
              onChange={(e) => set(i, { value: e.target.value })}
              placeholder="nilai"
              className="flex-1 rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1.5 font-mono text-xs outline-none focus:border-[var(--accent)]"
            />
            <button
              type="button"
              onClick={() => onChange(value.filter((_, j) => j !== i))}
              className="px-2 text-sm text-[var(--muted)] hover:text-rose-400"
              aria-label="Hapus baris"
            >
              ×
            </button>
          </div>
          {DANGEROUS_KEYS.has(pair.key.trim()) && (
            <p className="pl-1 text-xs text-amber-400">
              {pair.key.trim() === "DATABASE_URL"
                ? "Mengubah ini mengarahkan app ke database lain — data lama tetap di /srv/data dan akan terlihat seperti hilang."
                : "Mengubah ini membuat semua sesi login pengguna langsung tidak berlaku."}
            </p>
          )}
        </div>
      ))}

      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => onChange([...value, { key: "", value: "" }])}
          className="rounded-md border border-[var(--border)] px-2 py-1 text-xs text-[var(--muted)] hover:text-[var(--text)]"
        >
          + Tambah
        </button>
      </div>

      <details className="text-xs text-[var(--muted)]">
        <summary className="cursor-pointer select-none">Tempel format .env</summary>
        <textarea
          value={paste}
          onChange={(e) => setPaste(e.target.value)}
          rows={4}
          placeholder={"SMTP_HOST=mail.contoh.com\nSMTP_PASS=rahasia"}
          className="mt-2 w-full rounded-md border border-[var(--border)] bg-[var(--panel-2)] p-2 font-mono text-xs outline-none focus:border-[var(--accent)]"
        />
        <button
          type="button"
          onClick={() => { onChange([...value, ...parseDotenv(paste)]); setPaste(""); }}
          className="mt-1 rounded-md border border-[var(--border)] px-2 py-1 hover:text-[var(--text)]"
        >
          Impor
        </button>
      </details>
    </div>
  );
}
```

- [ ] **Step 5: Implementasi `components/UploadForm.tsx`**

```tsx
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { EnvEditor } from "./EnvEditor";
import type { EnvPair } from "@/lib/envfile";

export function UploadForm() {
  const [file, setFile] = useState<File | null>(null);
  const [project, setProject] = useState("");
  const [env, setEnv] = useState<EnvPair[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const router = useRouter();

  function pick(f: File | null) {
    setFile(f);
    if (f && !project) setProject(f.name.replace(/\.zip$/i, ""));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!file) return;
    setBusy(true);
    setError("");

    const body = new FormData();
    body.set("zip", file);
    body.set("project", project);
    body.set("env", JSON.stringify(env.filter((p) => p.key.trim())));

    const res = await fetch("/api/deploys", { method: "POST", body });
    const data = await res.json();
    setBusy(false);

    if (!res.ok) return setError(data.error ?? "Gagal memulai deploy.");
    router.push(`/deploys/${data.id}`);
  }

  return (
    <form onSubmit={submit} className="space-y-4 rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4">
      <div
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => { e.preventDefault(); setDragging(false); pick(e.dataTransfer.files[0] ?? null); }}
        className={`grid place-items-center rounded-lg border border-dashed p-6 text-center transition-colors ${
          dragging ? "border-[var(--accent)] bg-[var(--accent)]/5" : "border-[var(--border)]"
        }`}
      >
        <input
          id="zip" type="file" accept=".zip,application/zip"
          onChange={(e) => pick(e.target.files?.[0] ?? null)} className="hidden"
        />
        <label htmlFor="zip" className="cursor-pointer text-sm">
          {file ? (
            <span className="font-mono text-[var(--text)]">
              {file.name} <span className="text-[var(--muted)]">({(file.size / 1e6).toFixed(1)} MB)</span>
            </span>
          ) : (
            <>
              <span className="text-[var(--accent)]">Pilih file zip</span>
              <span className="text-[var(--muted)]"> atau seret ke sini</span>
            </>
          )}
        </label>
      </div>

      <div>
        <label className="text-sm font-medium">Nama project</label>
        <input
          value={project}
          onChange={(e) => setProject(e.target.value)}
          placeholder="kanban-clone"
          className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1.5 font-mono text-sm outline-none focus:border-[var(--accent)]"
        />
        <p className="mt-1 text-xs text-[var(--muted)]">
          Harus sama dengan deploy sebelumnya agar data lama tetap terpakai.
        </p>
      </div>

      <EnvEditor value={env} onChange={setEnv} />

      {error && <p className="text-sm text-rose-400">{error}</p>}

      <button
        disabled={!file || !project || busy}
        className="w-full rounded-lg bg-[var(--accent)] px-3 py-2 text-sm font-medium text-white disabled:opacity-40"
      >
        {busy ? "Mengunggah…" : "Deploy"}
      </button>
    </form>
  );
}
```

- [ ] **Step 6: Implementasi `components/DeployList.tsx`**

```tsx
"use client";

import Link from "next/link";
import { STATUS_STYLE, formatRelative } from "@/lib/format";

export interface DeploySummary {
  id: string; project: string; status: string; created_at: number; sha: string | null;
}

export function DeployList({ deploys, activeId }: { deploys: DeploySummary[]; activeId?: string }) {
  if (deploys.length === 0) {
    return <p className="px-3 py-6 text-center text-sm text-[var(--muted)]">Belum ada deployment.</p>;
  }

  return (
    <ul className="space-y-1">
      {deploys.map((d) => {
        const s = STATUS_STYLE[d.status] ?? STATUS_STYLE.queued;
        return (
          <li key={d.id}>
            <Link
              href={`/deploys/${d.id}`}
              className={`block rounded-lg border px-3 py-2 transition-colors ${
                d.id === activeId
                  ? "border-[var(--accent)]/50 bg-[var(--panel-2)]"
                  : "border-transparent hover:bg-[var(--panel-2)]"
              }`}
            >
              <div className="flex items-center gap-2">
                <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${s.dot}`} />
                <span className="truncate font-mono text-sm">{d.project}</span>
                <span className={`ml-auto shrink-0 text-xs ${s.text}`}>{s.label}</span>
              </div>
              <div className="mt-0.5 pl-3.5 text-xs text-[var(--muted)]">
                {d.sha && <span className="font-mono">{d.sha} · </span>}
                {formatRelative(d.created_at)}
              </div>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
```

- [ ] **Step 7: Implementasi `app/page.tsx`**

```tsx
import { redirect } from "next/navigation";
import { isAuthed } from "@/lib/auth";
import { getServer } from "@/lib/server";
import { DeployList } from "@/components/DeployList";
import { UploadForm } from "@/components/UploadForm";

export const dynamic = "force-dynamic";

export default async function Home() {
  if (!(await isAuthed())) redirect("/login");
  const deploys = getServer().db.listDeploys(50);

  return (
    <main className="mx-auto grid max-w-5xl gap-6 p-6 md:grid-cols-[1fr_320px]">
      <section className="order-2 md:order-1">
        <h2 className="mb-2 text-sm font-medium text-[var(--muted)]">Riwayat deployment</h2>
        <DeployList deploys={deploys} />
      </section>
      <section className="order-1 md:order-2">
        <h1 className="mb-2 text-sm font-medium text-[var(--muted)]">Deploy baru</h1>
        <UploadForm />
      </section>
    </main>
  );
}
```

- [ ] **Step 8: Perbarui `app/layout.tsx`**

```tsx
import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Deploy Monitor",
  description: "Monitor deployment untuk VPS1/VPS2",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="id">
      <body>{children}</body>
    </html>
  );
}
```

- [ ] **Step 9: Verifikasi build**

Run: `npm run build`
Expected: build sukses

- [ ] **Step 10: Commit**

```bash
git add app components lib/format.ts
git commit -m "feat: halaman login, dashboard, dan form upload dengan editor env"
```

---

### Task 15: Frontend — log viewer realtime

**Files:**
- Create: `app/deploys/[id]/page.tsx`, `components/LogViewer.tsx`, `components/PhaseTimeline.tsx`, `components/DeploySummary.tsx`

**Interfaces:**
- Consumes: SSE dari Task 13, `parseAnsi` (Task 6), `PHASES` (Task 7)
- Produces: —

- [ ] **Step 1: Implementasi `components/PhaseTimeline.tsx`**

```tsx
"use client";

import { PHASES } from "@/lib/phases";

export function PhaseTimeline({ phase, status }: { phase: string | null; status: string }) {
  const current = PHASES.findIndex((p) => p.id === phase);
  const failed = status === "failed" || status === "interrupted";

  return (
    <ol className="flex flex-wrap gap-1.5">
      {PHASES.map((p, i) => {
        const done = current >= 0 && i < current;
        const active = i === current;
        const tone = active && failed ? "border-rose-500/50 text-rose-300"
          : active ? "border-sky-400/50 text-sky-300"
          : done ? "border-emerald-500/30 text-emerald-400/80"
          : "border-[var(--border)] text-[var(--muted)]";
        return (
          <li key={p.id} className={`rounded-md border px-2 py-0.5 text-xs ${tone}`}>
            {p.label}
          </li>
        );
      })}
    </ol>
  );
}
```

- [ ] **Step 2: Implementasi `components/DeploySummary.tsx`**

```tsx
"use client";

import { STATUS_STYLE, formatDuration } from "@/lib/format";

export interface DeployDetail {
  id: string; project: string; status: string; phase: string | null;
  started_at: number | null; ended_at: number | null; exit_code: number | null;
  sha: string | null; image: string | null; live_url: string | null;
  zip_name: string; env_keys: string; error: string | null;
}

export function DeploySummary({ d }: { d: DeployDetail }) {
  const s = STATUS_STYLE[d.status] ?? STATUS_STYLE.queued;
  const envKeys: string[] = JSON.parse(d.env_keys || "[]");
  const elapsed = d.started_at ? (d.ended_at ?? Date.now()) - d.started_at : null;

  return (
    <div className="space-y-3 rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4">
      <div className="flex items-center gap-2">
        <span className={`h-2 w-2 rounded-full ${s.dot}`} />
        <span className="font-mono text-sm">{d.project}</span>
        <span className={`text-xs ${s.text}`}>{s.label}</span>
        {elapsed !== null && (
          <span className="ml-auto text-xs text-[var(--muted)]">{formatDuration(elapsed)}</span>
        )}
      </div>

      {d.status === "success" && d.live_url && (
        <a
          href={d.live_url} target="_blank" rel="noreferrer"
          className="block truncate rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-sm text-emerald-300 hover:bg-emerald-500/10"
        >
          {d.live_url} ↗
        </a>
      )}

      {d.error && (
        <p className="rounded-lg border border-rose-500/30 bg-rose-500/5 px-3 py-2 text-sm text-rose-300">
          {d.error}
        </p>
      )}

      <dl className="space-y-1 text-xs">
        {([
          ["Berkas", d.zip_name],
          ["Commit", d.sha],
          ["Image", d.image],
          ["Exit code", d.exit_code === null ? null : String(d.exit_code)],
          // Hanya NAMA key — nilainya memang tidak pernah disimpan (spec D7).
          ["Env di-override", envKeys.length ? envKeys.join(", ") : null],
        ] as [string, string | null][])
          .filter(([, v]) => v)
          .map(([k, v]) => (
            <div key={k} className="flex gap-2">
              <dt className="w-28 shrink-0 text-[var(--muted)]">{k}</dt>
              <dd className="truncate font-mono">{v}</dd>
            </div>
          ))}
      </dl>

      <a
        href={`/api/deploys/${d.id}/logs?plain=1`}
        className="inline-block text-xs text-[var(--muted)] underline hover:text-[var(--text)]"
      >
        Unduh log
      </a>
    </div>
  );
}
```

- [ ] **Step 3: Implementasi `components/LogViewer.tsx`**

```tsx
"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { parseAnsi, type LogColor } from "@/lib/ansi";
import { PhaseTimeline } from "./PhaseTimeline";
import { DeploySummary, type DeployDetail } from "./DeploySummary";

interface Line { seq: number; stream: string; text: string }

const COLOR: Record<LogColor, string> = {
  red: "var(--log-red)", green: "var(--log-green)", yellow: "var(--log-yellow)",
  blue: "var(--log-blue)", magenta: "var(--log-magenta)", cyan: "var(--log-cyan)",
};

export function LogViewer({ initial }: { initial: DeployDetail }) {
  const [deploy, setDeploy] = useState(initial);
  const [lines, setLines] = useState<Line[]>([]);
  const [filter, setFilter] = useState("");
  const [stick, setStick] = useState(true);

  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const es = new EventSource(`/api/deploys/${initial.id}/stream`);

    es.addEventListener("line", (e) => {
      const l = JSON.parse((e as MessageEvent).data) as Line;
      // Dedup: replay saat reconnect bisa tumpang tindih dengan siaran langsung.
      setLines((prev) => (prev.at(-1) && prev.at(-1)!.seq >= l.seq ? prev : [...prev, l]));
    });

    es.addEventListener("state", (e) => {
      const { deploy: d } = JSON.parse((e as MessageEvent).data) as { deploy: DeployDetail };
      if (d) setDeploy(d);
    });

    return () => es.close();
  }, [initial.id]);

  // Auto-scroll, tapi berhenti begitu user menggulir ke atas.
  useEffect(() => {
    if (!stick) return;
    const box = boxRef.current;
    if (box) box.scrollTop = box.scrollHeight;
  }, [lines, stick]);

  const shown = useMemo(
    () => (filter ? lines.filter((l) => l.text.toLowerCase().includes(filter.toLowerCase())) : lines),
    [lines, filter],
  );

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_300px]">
      <div className="order-2 min-w-0 lg:order-1">
        <div className="mb-2 flex items-center gap-2">
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Cari di log…"
            className="flex-1 rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1 text-xs outline-none focus:border-[var(--accent)]"
          />
          <span className="shrink-0 text-xs text-[var(--muted)]">{shown.length} baris</span>
        </div>

        <div
          ref={boxRef}
          onScroll={(e) => {
            const el = e.currentTarget;
            setStick(el.scrollHeight - el.scrollTop - el.clientHeight < 40);
          }}
          className="h-[65vh] overflow-auto rounded-xl border border-[var(--border)] bg-[#06070a] p-3 font-mono text-xs leading-relaxed"
        >
          {shown.length === 0 && (
            <p className="text-[var(--muted)]">
              {deploy.status === "queued" ? "Menunggu giliran…" : "Menunggu output…"}
            </p>
          )}
          {shown.map((l) => (
            <div key={l.seq} className="whitespace-pre-wrap break-all">
              {parseAnsi(l.text).map((sp, i) => (
                <span
                  key={i}
                  style={{
                    color: sp.color ? COLOR[sp.color] : l.stream === "stderr" ? "var(--log-red)" : undefined,
                    fontWeight: sp.bold ? 600 : undefined,
                  }}
                >
                  {sp.text}
                </span>
              ))}
            </div>
          ))}
        </div>

        {!stick && (
          <button
            onClick={() => setStick(true)}
            className="mt-2 rounded-md border border-[var(--border)] px-2 py-1 text-xs text-[var(--muted)] hover:text-[var(--text)]"
          >
            ↓ Ikuti log terbaru
          </button>
        )}
      </div>

      <aside className="order-1 space-y-3 lg:order-2">
        <DeploySummary d={deploy} />
        <div className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4">
          <h3 className="mb-2 text-xs font-medium text-[var(--muted)]">Tahapan</h3>
          <PhaseTimeline phase={deploy.phase} status={deploy.status} />
        </div>
      </aside>
    </div>
  );
}
```

- [ ] **Step 4: Implementasi `app/deploys/[id]/page.tsx`**

```tsx
import Link from "next/link";
import { redirect, notFound } from "next/navigation";
import { isAuthed } from "@/lib/auth";
import { getServer } from "@/lib/server";
import { LogViewer } from "@/components/LogViewer";
import type { DeployDetail } from "@/components/DeploySummary";

export const dynamic = "force-dynamic";

export default async function DeployPage(
  { params }: { params: Promise<{ id: string }> },
) {
  if (!(await isAuthed())) redirect("/login");

  const { id } = await params;
  const deploy = getServer().db.getDeploy(id);
  if (!deploy) notFound();

  return (
    <main className="mx-auto max-w-6xl space-y-4 p-6">
      <Link href="/" className="text-xs text-[var(--muted)] hover:text-[var(--text)]">
        ← Semua deployment
      </Link>
      <LogViewer initial={deploy as unknown as DeployDetail} />
    </main>
  );
}
```

- [ ] **Step 5: Verifikasi build dan tipe**

Run: `npm run build && npx tsc --noEmit`
Expected: build sukses, tanpa error tipe

- [ ] **Step 6: Commit**

```bash
git add app/deploys components/LogViewer.tsx components/PhaseTimeline.tsx components/DeploySummary.tsx
git commit -m "feat: log viewer realtime dengan warna, timeline fase, dan ringkasan"
```

---

### Task 16: Uji asap end-to-end secara lokal

Membuktikan seluruh rangkaian bekerja sebelum menyentuh VPS.

**Files:**
- Create: `scripts/smoke.sh`

- [ ] **Step 1: Tulis skrip uji asap**

`scripts/smoke.sh`:

```bash
#!/usr/bin/env bash
# Menjalankan aplikasi dengan deploy.sh PALSU dan sebuah zip sungguhan, lalu
# memverifikasi API dari ujung ke ujung. Tidak butuh docker maupun VPS.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"; kill "${PID:-0}" 2>/dev/null || true' EXIT

export MONITOR_TOKEN="token-uji"
export EXECUTOR=local
export DEPLOY_SH="$ROOT/tests/fixtures/fake-deploy.sh"
export UPLOADS_DIR="$WORK/uploads"
export DB_PATH="$WORK/monitor.db"
export PUBLIC_HOST="203.0.113.9"
export PORT=3999

mkdir -p "$WORK/src"
printf 'FROM node:22-alpine\nEXPOSE 3000\n' > "$WORK/src/Dockerfile"
(cd "$WORK/src" && zip -qr "$WORK/app.zip" .)

npm run build >/dev/null
npm start -- --port "$PORT" >"$WORK/server.log" 2>&1 & PID=$!

for _ in $(seq 1 40); do
  curl -sf "http://localhost:$PORT/login" >/dev/null 2>&1 && break
  sleep 0.5
done

JAR="$WORK/cookies"
curl -sf -c "$JAR" -X POST "http://localhost:$PORT/api/auth/login" \
  -H 'content-type: application/json' -d '{"token":"token-uji"}' >/dev/null
echo "  ok   login"

ID=$(curl -sf -b "$JAR" -X POST "http://localhost:$PORT/api/deploys" \
  -F "zip=@$WORK/app.zip" -F "project=Uji Coba!" \
  -F 'env=[{"key":"SMTP_PASS","value":"JANGAN_BOCOR"}]' | sed 's/.*"id":"\([^"]*\)".*/\1/')
echo "  ok   deploy dimulai: $ID"

for _ in $(seq 1 60); do
  STATUS=$(curl -sf -b "$JAR" "http://localhost:$PORT/api/deploys/$ID" | sed 's/.*"status":"\([^"]*\)".*/\1/')
  [ "$STATUS" = "success" ] || [ "$STATUS" = "failed" ] && break
  sleep 0.5
done

LOGS=$(curl -sf -b "$JAR" "http://localhost:$PORT/api/deploys/$ID/logs?plain=1")

fail() { echo "  FAIL $1"; exit 1; }
[ "$STATUS" = "success" ]                        || fail "status = $STATUS"
echo "$LOGS" | grep -q "Building image"          || fail "penanda fase tidak ada di log"
echo "$LOGS" | grep -q "JANGAN_BOCOR"            && fail "NILAI ENV BOCOR KE LOG"
echo "$LOGS" | grep -q "SMTP_PASS"               || fail "nama key env tidak dicatat"
[ -d "$UPLOADS_DIR/uji-coba/.git" ]              || fail "nama project tidak dinormalkan jadi 'uji-coba'"

echo "  ok   status sukses, fase tercatat, nilai env tidak bocor, nama dinormalkan"
echo "UJI ASAP LULUS"
```

- [ ] **Step 2: Jalankan uji asap**

Run: `chmod +x scripts/smoke.sh && ./scripts/smoke.sh`
Expected: `UJI ASAP LULUS`

- [ ] **Step 3: Jalankan seluruh verifikasi**

Run: `npm test && ./tests/scripts/env-override.test.sh && npm run build`
Expected: semua lulus

- [ ] **Step 4: Commit**

```bash
git add scripts/smoke.sh
git commit -m "test: uji asap end-to-end tanpa docker maupun VPS"
```

---

### Task 17: `setup.md`

Ditulis untuk orang yang **hanya punya web console**, tanpa password SSH.

**Files:**
- Create: `setup.md`

- [ ] **Step 1: Tulis `setup.md`**

Isinya harus memuat, dengan urutan ini:

1. **Ringkasan yang berubah** — tabel tiga kolom: VPS1 (pasang aplikasi + Node 24), VPS2 (ganti `run.sh`), aplikasi (env var). VPS2 **tidak** perlu perubahan lain.

2. **Prasyarat VPS1** — Node 24+ (wajib, karena `node:sqlite`), `git`, `docker`, `unzip` tidak diperlukan (extract dilakukan di dalam Node). Perintah lengkap pasang Node 24 lewat NodeSource, siap tempel ke web console.

3. **Memasukkan kode ke VPS1 tanpa SSH.** Jelaskan bahwa `git clone` dari GitHub adalah jalurnya, karena VPS1 sudah punya git dan jaringan. Sertakan langkah untuk repo privat (personal access token di URL clone) dan peringatan agar token tidak ikut tersimpan di remote URL.

4. **Systemd unit** — file lengkap siap tempel:
   ```ini
   [Unit]
   Description=Deploy Monitor
   After=network-online.target docker.service

   [Service]
   Type=simple
   WorkingDirectory=/srv/monitor/app
   EnvironmentFile=/srv/monitor/monitor.env
   ExecStart=/usr/bin/node node_modules/.bin/next start --port 3000
   Restart=always
   RestartSec=3
   # Build docker memakan RAM besar. Tanpa ini, monitor bisa jadi korban OOM
   # killer tepat saat kamu sedang menonton build berjalan.
   OOMScoreAdjust=-500

   [Install]
   WantedBy=multi-user.target
   ```

5. **`monitor.env`** — semua variabel dari spec §11, dengan `chmod 600`, plus cara membuat `MONITOR_TOKEN` (`openssl rand -hex 32`).

6. **Memperbarui `run.sh` di VPS2** — karena tidak ada SSH dari laptop, langkahnya: tempel isi `run.sh` yang baru lewat web console dengan `cat > /srv/platform/run.sh <<'EOF'`. Tegaskan kutip tunggal pada `'EOF'` — tanpa itu shell akan mengekspansi `${...}` di dalam script dan merusaknya.

7. **Firewall** — dua pilihan, jelaskan trade-off-nya: (a) buka port 3000 ke publik, aman hanya karena `MONITOR_TOKEN`; (b) bind ke `127.0.0.1` lalu akses lewat SSH tunnel. Sebutkan bahwa aplikasi jalan sebagai root, jadi (b) lebih aman.

8. **Verifikasi** — `systemctl status`, `journalctl -u deploy-monitor -f`, dan buka UI.

9. **Catatan RAM** — kalau VPS1 di bawah 4 GB, tambahkan swap; sertakan perintahnya. Build Next.js di mesin kecil sering OOM terlepas dari aplikasi ini.

- [ ] **Step 2: Verifikasi setiap blok perintah**

Periksa satu per satu: perintah systemd valid, path konsisten dengan `monitor.env`, dan heredoc memakai `'EOF'` berkutip.

- [ ] **Step 3: Commit**

```bash
git add setup.md
git commit -m "docs: setup.md untuk instalasi lewat web console tanpa SSH"
```

---

### Task 18: `runbook.md`

**Files:**
- Create: `runbook.md`

- [ ] **Step 1: Tulis `runbook.md`**

Ditujukan untuk orang yang mau **mendeploy aplikasinya**, bukan memasang sistem ini. Harus memuat:

1. **Dependency di dalam zip** — checklist yang bisa dicentang:
   - `Dockerfile` di root zip (atau di dalam satu folder pembungkus — itu dilepas otomatis)
   - `USER` numerik, mis. `USER 1001:1001` — nama user ditolak `deploy.sh:298`
   - `EXPOSE <port>`
   - devDependencies **ikut** di image (drizzle-kit, tsx) — jangan `--prod`
   - folder migrasi (`drizzle/` termasuk `meta/_journal.json`) ikut di zip
   - `deploy.env` opsional, dan berbeda dari `DEPLOYMENT.md` lama: **tidak perlu di-commit**, cukup ada di dalam zip

2. **Perbedaan penting dari alur git lama** — tabel: aturan "semua harus di-commit" tidak berlaku lagi; apa pun yang ada di zip pasti terpakai. Tapi `.dockerignore` tetap berlaku saat build.

3. **Langkah deploy** — enam langkah dengan tangkapan hasil yang diharapkan:
   zip folder project → buka UI → pilih zip → isi nama project (tegaskan: **harus sama persis** dengan deploy sebelumnya, kalau tidak dianggap project baru dan `/srv/data/<project>` lama tidak terpakai) → isi env yang perlu → Deploy.

4. **Membaca timeline fase** — apa arti tiap tahap, dan mana yang paling sering gagal (Build dan Migrasi).

5. **Env var** — jelaskan semantik per-key dengan contoh konkret sebelum/sesudah. Tegaskan: kosongkan form kalau tidak ada yang mau diubah; nilai lama di VPS2 tetap terpakai. Sertakan peringatan `BETTER_AUTH_SECRET` dan `DATABASE_URL`.

6. **Kegagalan yang lazim** — tabel gejala → penyebab → tindakan:

   | Gejala di log | Penyebab | Tindakan |
   |---|---|---|
   | `Dockerfile not found` | Zip berisi lebih dari satu folder di root sehingga pembungkus tidak dilepas | Zip **isi** foldernya, bukan foldernya |
   | `Image USER is '...', which is a name` | `USER app` bukan angka | Ganti jadi `USER 1001:1001` |
   | `Found migration files but could not determine how to apply them` | Ada folder migrasi tanpa `MIGRATE_CMD` | Tambahkan `MIGRATE_CMD` di `deploy.env` dalam zip |
   | `migrate : <none>` padahal app punya DB | Deteksi gagal | **Hentikan** — lihat `DEPLOYMENT.md` aturan no. 9 |
   | `drizzle-kit: not found` | Image di-prune, devDependencies hilang | Jangan `pnpm install --prod` |
   | Status `Terputus` | Service monitor restart di tengah deploy | Cek `journalctl -u deploy-monitor`; kemungkinan OOM |

7. **Yang tetap manual di VPS2** — sesuai cakupan v1 (spec §15): lihat log runtime (`app.sh <project> logs -f`), rollback lewat `current-image`, restore database. Tunjuk ke `DEPLOYMENT.md` §10 daripada menyalin isinya.

- [ ] **Step 2: Periksa silang dengan `DEPLOYMENT.md`**

Pastikan setiap nomor baris dan nama file yang dikutip masih benar terhadap `deploy/deploy.sh` dan `deploy/run.sh` versi terbaru.

- [ ] **Step 3: Commit**

```bash
git add runbook.md
git commit -m "docs: runbook.md untuk pemakai yang mendeploy lewat aplikasi ini"
```

---

## Self-Review

**Spec coverage:**

| Bagian spec | Task |
|---|---|
| §3 D1 aplikasi di VPS1 | 17 (systemd) |
| §3 D2 Executor local+ssh | 9 |
| §3 D3 staging git repo | 4 |
| §3 D4 auth token | 12 |
| §3 D5 tidak menyentuh VPS2 | 11 (lewat `deploy.sh`) |
| §3 D6 upsert di `run.sh` | 11 |
| §3 D7 hanya nama key | 8, 10 |
| §5 normalisasi nama | 2 |
| §6 validasi env | 5 |
| §7 patch script | 11 |
| §8 intake zip | 3 |
| §8 fase | 7 |
| §8 log & SSE | 6, 13, 15 |
| §8 antrian serial | 10 |
| §9 data | 8 |
| §10 API | 12, 13 |
| §11 konfigurasi | 1 |
| §12 UI | 14, 15 |
| §13 penanganan error | 3, 10, 12 |
| §14 testing | tiap task + 16 |
| §16 deliverable | 17, 18 |

**Placeholder scan:** Task 17 dan 18 mendeskripsikan struktur dokumen, bukan kode — isinya ditentukan lengkap (bagian, tabel, unit systemd, isi tabel kegagalan) sehingga tidak ada keputusan yang tertunda. Semua task kode berisi kode sungguhan.

**Type consistency:** `EnvPair` (Task 5) dipakai di 10, 12, 14. `LogChunk` (9) dikonsumsi 10. `Db`/`DeployRow` (8) dipakai 10, 12, 13. `Executor.run/writeFile/remove` (9) — ketiganya dipanggil di 10. `stripAnsi`/`detectPhase`/`detectSummary` (7) dipakai 10 dan 12. `PHASES` (7) dipakai 15. `parseAnsi`/`Span`/`LogColor` (6) dipakai 15. `DANGEROUS_KEYS` (5) dipakai 14. `bus.emitLine/emitState` (10) dikonsumsi 13.

**Catatan:** `lib/envfile.ts` dan `lib/phases.ts` diimpor komponen klien. Keduanya murni — tanpa `node:` import — jadi aman di-bundle ke browser. `lib/ansi.ts` juga.
