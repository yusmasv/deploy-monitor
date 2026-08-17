import { describe, it, expect } from "vitest";
import { normalizeProject } from "../lib/project";

describe("normalizeProject", () => {
  it("menirukan aturan deploy.sh:70", () => {
    expect(normalizeProject("Kanban-Clone")).toBe("kanban-clone");
    expect(normalizeProject("My App!")).toBe("my-app");     // spasi & '!' -> '-', trailing dibuang
    expect(normalizeProject("app_v2.1")).toBe("app_v2.1");  // '_' '.' aman
  });

  it("membuang SEMUA tanda hubung di akhir, bukan cuma satu", () => {
    // deploy.sh:71 (${PROJECT%-}) hanya membuang satu. Kalau kita ikut membuang
    // satu, "app--" jadi "app-", lalu deploy.sh menurunkan PROJECT="app" —
    // berbeda dari nama direktori kita. Hasil kita harus TITIK-TETAP dari
    // aturan deploy.sh, dan itu berarti tanpa sisa tanda hubung di akhir.
    expect(normalizeProject("app--")).toBe("app");
    expect(normalizeProject("app-")).toBe("app");
    expect(normalizeProject("-app")).toBe("-app");   // di awal tidak disentuh
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
