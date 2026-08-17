import { describe, it, expect } from "vitest";
// Dari lib/token, BUKAN lib/auth: lib/auth mengimpor next/headers pada level
// modul, yang gagal dimuat di lingkungan node Vitest tanpa runtime Next dan
// akan membuat seluruh file test ini error sebelum satu assertion pun jalan.
import { tokenMatches } from "../lib/token";

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
