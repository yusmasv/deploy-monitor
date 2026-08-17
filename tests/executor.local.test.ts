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
});
