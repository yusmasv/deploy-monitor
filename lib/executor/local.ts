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
    // Dijaga: spawn yang gagal (ENOENT) bisa memancarkan 'error' DAN 'close',
    // dan tanpa penjaga ini dua chunk exit terkirim — konsumen membaca exit
    // code yang salah.
    const finish = (code: number) => {
      if (done) return;
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

    // try/finally, BUKAN sekadar loop telanjang. Kalau konsumen meninggalkan
    // generator ini lebih awal — `break` di tengah `for await`, atau (yang
    // berbahaya) badan loop konsumen MELEMPAR, mis. db.appendLine gagal
    // SQLITE_FULL di Runner.execute — runtime otomatis memanggil .return()
    // pada generator ini. Tanpa finally, generator sekadar berhenti dan
    // child process-nya TIDAK pernah dibunuh: deploy.sh terus jalan sebagai
    // root tanpa dipantau, output-nya dibuang, sementara pump() sudah
    // melanjutkan ke job berikutnya dan men-spawn deploy.sh KEDUA yang
    // merebut direktori build yang sama (invariant concurrency-1 jebol).
    // `done` baru true setelah finish() — jadi pada jalur normal (generator
    // habis sendiri, atau konsumen break setelah menerima chunk 'exit')
    // blok ini no-op.
    try {
      while (!done || queue.length > 0) {
        if (queue.length === 0) { await new Promise<void>((r) => { notify = r; }); continue; }
        yield queue.shift()!;
      }
    } finally {
      if (!done) child.kill("SIGTERM");
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
