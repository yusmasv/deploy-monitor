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
      say("stdout", `\x1b[0;36mMenerima ${extract.fileCount} file dari ${job.zipName}.\x1b[0m`);
      if (extract.strippedWrapper) {
        say("stdout", `\x1b[0;36mMelepas direktori pembungkus '${extract.strippedWrapper}'.\x1b[0m`);
      }

      const env: Record<string, string> = { ...this.o.extraEnv };
      if (job.env.length > 0) {
        // DI LUAR staging repo, disengaja. Kalau file secret ini ada di dalam
        // working tree git dan proses mati sebelum blok finally menghapusnya,
        // `git add -A` pada upload berikutnya bisa meng-commit-nya ke riwayat —
        // dari mana secret tidak bisa dihapus dengan mudah lagi.
        overridePath = join(this.o.uploadsDir, ".overrides", `${id}.env`);
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
      say("stderr", `\x1b[0;31m${message}\x1b[0m`);
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
