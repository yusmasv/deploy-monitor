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

// Direktori (di dalam uploadsDir) tempat file env-override sementara ditulis.
// HARUS mengandung karakter huruf besar: normalizeProject() (lib/project.ts)
// selalu memanggil .toLowerCase() sebelum memfilter karakter, jadi keluaran
// fungsi itu tidak pernah mengandung huruf besar sama sekali. Itu berarti
// TIDAK ADA nama project yang bisa menghasilkan string yang sama persis
// dengan OVERRIDES_DIR — jadi prepareStaging() (yang menulis isi upload ke
// join(uploadsDir, normalizeProject(project))) tidak akan pernah menimpa
// atau membaca direktori ini. Itu penting karena Runner menyimpan file
// secret (env override) tepat di sini, DI LUAR direktori project manapun —
// lihat komentar di execute() soal kenapa override tidak boleh pernah ikut
// masuk ke build context yang dibaca `docker build`.
export const OVERRIDES_DIR = ".Overrides";

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
    this.emitState(id);
    this.pump();
    return id;
  }

  /** Khusus test. Produksi tidak pernah menunggu antrian kosong. */
  waitForIdle(): Promise<void> { return this.idle; }

  // bus adalah EventEmitter: listener yang throw (mis. rute SSE (Task 13)
  // yang mencoba menulis ke ReadableStream yang controller-nya sudah
  // ditutup karena tab browser ditutup — kejadian rutin, bukan kegagalan
  // aplikasi) membuat emit() melempar SECARA SINKRON ke pemanggilnya.
  // Kalau dibiarkan menjalar, ia bisa membatalkan while-loop di pump()
  // (Finding 2): this.active tidak pernah kembali ke false, setiap pump()
  // berikutnya jadi no-op, dan seluruh antrian macet permanen untuk sisa
  // umur proses. Semua emisi bus di sini dibungkus supaya listener yang
  // meledak hanya kehilangan satu event SSE, bukan menjatuhkan antrian.
  private emitState(deployId: string): void {
    try { bus.emitState({ deployId }); } catch { /* lihat komentar di atas */ }
  }

  private pump(): void {
    if (this.active) return;
    this.active = true;
    this.idle = (async () => {
      try {
        while (this.queue.length > 0) {
          const next = this.queue.shift()!;
          try {
            await this.execute(next.id, next.job);
          } catch (err) {
            // execute() sendiri sudah mencatat status "failed" ke DB sebelum
            // melempar apa pun yang tersisa (lihat blok catch/finally di
            // sana) — try/catch ini murni jaring pengaman terakhir supaya
            // satu deploy yang meledak tak terduga tidak pernah menghentikan
            // antrian secara permanen (Finding 2, bagian pump()).
            //
            // Satu jalur yang lolos SEBELUM catch milik execute() dimulai:
            // db.updateDeploy(status "running") di baris pertama execute().
            // Kalau ITU yang gagal (mis. disk penuh), deploy tertinggal di
            // "queued" selamanya. Tanpa log di sini tidak ada jejak APA PUN
            // soal kenapa — operator hanya melihat deploy yang tidak pernah
            // jalan. Yang dicatat cuma id dan pesan error: tidak pernah ada
            // nilai env di sini (spec D7).
            const message = err instanceof Error ? err.message : String(err);
            console.error(`[monitor] deploy ${next.id} gagal di luar execute(): ${message}`);
          }
        }
      } finally {
        this.active = false;
      }
    })();
  }

  private async execute(id: string, job: DeployJob): Promise<void> {
    const { db } = this.o;
    db.updateDeploy(id, { status: "running", started_at: Date.now() });
    this.emitState(id);

    const say = (stream: "stdout" | "stderr", text: string) => {
      const seq = db.appendLine(id, stream, text);
      try { bus.emitLine({ deployId: id, seq, stream, ts: Date.now(), text }); } catch { /* lihat emitState() */ }
      return seq;
    };

    let overridePath: string | null = null;

    try {
      const { dir, extract } = await prepareStaging({
        project: job.project, zip: job.zip,
        uploadsDir: this.o.uploadsDir, limits: this.o.limits,
      });
      say("stdout", `\x1b[0;36mMenerima ${extract.fileCount} file dari ${job.zipName}.\x1b[0m`);
      if (extract.strippedWrapper) {
        say("stdout", `\x1b[0;36mMelepas direktori pembungkus '${extract.strippedWrapper}'.\x1b[0m`);
      }

      const env: Record<string, string> = { ...this.o.extraEnv };
      if (job.env.length > 0) {
        // DI LUAR direktori project, disengaja. `dir` adalah persis apa yang
        // dibaca deploy.sh sebagai build context (`docker build`) — kalau
        // file secret ini ditulis di dalam `dir`, ia berisiko ikut ter-COPY
        // ke dalam layer image walau tidak pernah disebut di Dockerfile
        // (mis. lewat `COPY . .` yang umum). Menaruhnya di direktori terpisah
        // memastikan itu mustahil terjadi, bukan sekadar "biasanya aman".
        overridePath = join(this.o.uploadsDir, OVERRIDES_DIR, `${id}.env`);
        await this.o.executor.writeFile(overridePath, serializeOverrides(job.env), 0o600);
        env.ENV_OVERRIDES_FILE = overridePath;
        // Nama key saja. Nilai tidak boleh pernah masuk log.
        say("stdout", `\x1b[0;36mEnv override: ${job.env.map((e) => e.key).join(", ")}\x1b[0m`);
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
          this.emitState(id);
        }
        Object.assign(summary, detectSummary(plain) ?? {});
      }

      // summary.appPort is parsed from run.sh's "Port : <n> (container
      // listens on ...)" line, so despite the field name it's already
      // HOST_PORT — the port actually published on the runtime host, not
      // the container-internal one. See lib/phases.ts's detectSummary().
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
      // Status ditulis DULU, SEBELUM say() di bawah. say() bisa melempar
      // (mis. db.appendLine gagal) — kalau itu terjadi sebelum status
      // tercatat, deploy ini akan tertahan selamanya di status "running"
      // meski sudah pasti gagal (Finding 2, bagian catch). Menulis status
      // duluan membuat pencatatan log jadi best-effort, tidak pernah
      // menggerbangi (gate) pencatatan status.
      db.updateDeploy(id, { status: "failed", error: message, ended_at: Date.now() });
      say("stderr", `\x1b[0;31m${message}\x1b[0m`);
    } finally {
      // Sukses maupun gagal, secret tidak boleh tertinggal di disk.
      if (overridePath) {
        await this.o.executor.remove(overridePath).catch(() => {});
      }
      this.emitState(id);
    }
  }
}
