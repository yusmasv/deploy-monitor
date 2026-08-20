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
    expect(got[0].line).toBe("\x1b[0;32mok\x1b[0m");
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

  // Regression: spinner/progress bar (mis. `drizzle-kit migrate`) redraw pakai
  // \r, bukan \n. Sebelum fix, tiap frame numpuk jadi satu baris panjang di
  // LogViewer alih-alih ditimpa seperti terminal sungguhan menampilkannya.
  it("menimpa frame spinner yang diakhiri \\r, bukan menumpuknya", async () => {
    const got = await collect(
      ex.run("printf", ["frame1\\rframe2\\rframe3\\nbaris-biasa\\n"], {}),
    );
    const stdout = got.filter((c) => c.stream === "stdout").map((c) => c.line);
    expect(stdout).toEqual(["frame3", "baris-biasa"]);
  });

  it("tidak menyentuh akhir baris CRLF (\\r\\n)", async () => {
    const got = await collect(ex.run("printf", ["satu\\r\\ndua\\r\\n"], {}));
    const stdout = got.filter((c) => c.stream === "stdout").map((c) => c.line);
    expect(stdout).toEqual(["satu\r", "dua\r"]);
  });

  // Regression: badan `for await` milik konsumen yang MELEMPAR (di produksi:
  // db.appendLine gagal, mis. SQLITE_FULL, di dalam Runner.execute) membuat
  // runtime memanggil .return() pada generator ini. Sebelum fix, child
  // process-nya tidak pernah dibunuh — deploy.sh jadi proses root yatim yang
  // terus berjalan sementara Runner sudah men-spawn deploy.sh berikutnya.
  it("membunuh child process kalau konsumen meninggalkan generator karena error", async () => {
    let pid = 0;
    // `echo $$` dari `sh -c` mencetak pid sh itu sendiri — yaitu child yang
    // di-spawn, bukan cucu. `sleep 30` menjaga ia tetap hidup jauh melewati
    // durasi test kalau fix-nya tidak bekerja.
    const consume = async () => {
      for await (const c of ex.run("sh", ["-c", "echo $$; sleep 30"], {})) {
        if (c.stream === "stdout") {
          pid = Number(c.line);
          throw new Error("konsumen meledak");
        }
      }
    };

    await expect(consume()).rejects.toThrow("konsumen meledak");
    expect(pid).toBeGreaterThan(0);

    const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
    for (let i = 0; i < 100 && alive(); i++) await new Promise((r) => setTimeout(r, 20));
    expect(alive()).toBe(false);
  });
});
