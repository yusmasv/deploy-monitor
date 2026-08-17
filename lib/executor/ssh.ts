import { Client } from "ssh2";
import type { ClientChannel } from "ssh2";
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
    const wake = () => { notify?.(); notify = null; };
    const push = (c: LogChunk) => { queue.push(c); wake(); };
    let done = false;

    const buffers = { stdout: "", stderr: "" };
    const feed = (name: "stdout" | "stderr", chunk: string) => {
      buffers[name] += chunk;
      const lines = buffers[name].split("\n");
      buffers[name] = lines.pop() ?? "";
      for (const l of lines) push({ stream: name, line: l });
    };

    // Hanya menunggu sampai stream diperoleh dari conn.exec — BUKAN sampai
    // 'close'. Kalau ditunggu sampai 'close', while-loop di bawah baru mulai
    // setelah proses jarak jauh selesai, jadi 'notify' masih null selama itu
    // dan setiap push() dari feed() cuma menumpuk di queue tanpa konsumen
    // yang mendengarkan — output "streaming" jadi satu semburan di akhir,
    // bukan baris demi baris seperti local.ts.
    const stream = await new Promise<ClientChannel>((res, rej) => {
      conn.exec(line, (err, stream) => {
        if (err) return rej(err);
        res(stream);
      });
    });

    // Sama seperti finish() di local.ts: baris terakhir tanpa newline tetap
    // dikirim, lalu chunk exit, lalu tandai selesai dan bangunkan while-loop.
    const finish = (code: number) => {
      if (done) return;
      for (const n of ["stdout", "stderr"] as const) {
        if (buffers[n]) { push({ stream: n, line: buffers[n] }); buffers[n] = ""; }
      }
      push({ stream: "exit", code });
      done = true;
      conn.end();
      wake();
    };

    stream.on("data", (d: Buffer) => feed("stdout", d.toString("utf8")));
    stream.stderr.on("data", (d: Buffer) => feed("stderr", d.toString("utf8")));
    stream.on("close", (code: number) => finish(code ?? 1));

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
