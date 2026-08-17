import { describe, it, expect } from "vitest";
import { parseAnsi } from "../lib/ansi";

const E = "\x1b";

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
