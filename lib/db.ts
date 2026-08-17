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
