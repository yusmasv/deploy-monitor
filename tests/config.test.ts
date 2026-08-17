import { describe, it, expect } from "vitest";
import { loadConfig } from "../lib/config";

// Panjangnya harus >= batas minimum di loadConfig (24 karakter); ini bukan
// token sungguhan, hanya nilai yang cukup panjang untuk lolos validasi.
const TOKEN = "t".repeat(32);

describe("loadConfig", () => {
  it("menolak MONITOR_TOKEN yang kosong", () => {
    expect(() => loadConfig({})).toThrow(/MONITOR_TOKEN/);
  });

  it("menolak MONITOR_TOKEN yang terlalu pendek", () => {
    // 23 karakter: satu di bawah batas. Aplikasi harus gagal start, bukan
    // berjalan dengan token yang bisa ditebak — token ini satu-satunya
    // penjaga endpoint yang menjalankan deploy sebagai root.
    expect(() => loadConfig({ MONITOR_TOKEN: "a".repeat(23) })).toThrow(/terlalu pendek/i);
    expect(() => loadConfig({ MONITOR_TOKEN: "rahasia" })).toThrow(/MONITOR_TOKEN/);
  });

  it("menerima MONITOR_TOKEN tepat sepanjang batas minimum", () => {
    expect(loadConfig({ MONITOR_TOKEN: "a".repeat(24) }).monitorToken).toBe("a".repeat(24));
  });

  it("tidak pernah membocorkan nilai token di pesan error", () => {
    const weak = "rahasia-pendek";
    try {
      loadConfig({ MONITOR_TOKEN: weak });
      throw new Error("harus melempar");
    } catch (err) {
      expect((err as Error).message).not.toContain(weak);
    }
  });

  it("memakai default yang masuk akal", () => {
    const c = loadConfig({ MONITOR_TOKEN: TOKEN });
    expect(c.executor).toBe("local");
    expect(c.deploySh).toBe("/srv/platform/deploy.sh");
    expect(c.uploadsDir).toBe("/srv/uploads");
    expect(c.maxZipBytes).toBe(200 * 1024 * 1024);
  });

  it("mewajibkan SSH_HOST saat executor=ssh", () => {
    expect(() => loadConfig({ MONITOR_TOKEN: TOKEN, EXECUTOR: "ssh" })).toThrow(/SSH_HOST/);
  });

  it("memakai default maxZipBytes saat MAX_ZIP_BYTES tidak diset", () => {
    const c = loadConfig({ MONITOR_TOKEN: TOKEN });
    expect(c.maxZipBytes).toBe(200 * 1024 * 1024);
  });

  it("menerima MAX_ZIP_BYTES numerik yang valid", () => {
    const c = loadConfig({ MONITOR_TOKEN: TOKEN, MAX_ZIP_BYTES: "1048576" });
    expect(c.maxZipBytes).toBe(1048576);
  });

  it("menolak MAX_ZIP_BYTES kosong", () => {
    expect(() => loadConfig({ MONITOR_TOKEN: TOKEN, MAX_ZIP_BYTES: "" })).toThrow(/MAX_ZIP_BYTES/);
  });

  it("menolak MAX_ZIP_BYTES yang bukan angka", () => {
    expect(() => loadConfig({ MONITOR_TOKEN: TOKEN, MAX_ZIP_BYTES: "abc" })).toThrow(/MAX_ZIP_BYTES/);
  });

  it("menolak MAX_ZIP_BYTES nol", () => {
    expect(() => loadConfig({ MONITOR_TOKEN: TOKEN, MAX_ZIP_BYTES: "0" })).toThrow(/MAX_ZIP_BYTES/);
  });

  it("menolak MAX_ZIP_BYTES negatif", () => {
    expect(() => loadConfig({ MONITOR_TOKEN: TOKEN, MAX_ZIP_BYTES: "-5" })).toThrow(/MAX_ZIP_BYTES/);
  });
});
