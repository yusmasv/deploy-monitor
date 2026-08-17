import { describe, it, expect } from "vitest";
import { loadConfig } from "../lib/config";

describe("loadConfig", () => {
  it("menolak MONITOR_TOKEN yang kosong", () => {
    expect(() => loadConfig({})).toThrow(/MONITOR_TOKEN/);
  });

  it("memakai default yang masuk akal", () => {
    const c = loadConfig({ MONITOR_TOKEN: "rahasia" });
    expect(c.executor).toBe("local");
    expect(c.deploySh).toBe("/srv/platform/deploy.sh");
    expect(c.uploadsDir).toBe("/srv/uploads");
    expect(c.maxZipBytes).toBe(200 * 1024 * 1024);
  });

  it("mewajibkan SSH_HOST saat executor=ssh", () => {
    expect(() => loadConfig({ MONITOR_TOKEN: "x", EXECUTOR: "ssh" })).toThrow(/SSH_HOST/);
  });

  it("memakai default maxZipBytes saat MAX_ZIP_BYTES tidak diset", () => {
    const c = loadConfig({ MONITOR_TOKEN: "x" });
    expect(c.maxZipBytes).toBe(200 * 1024 * 1024);
  });

  it("menerima MAX_ZIP_BYTES numerik yang valid", () => {
    const c = loadConfig({ MONITOR_TOKEN: "x", MAX_ZIP_BYTES: "1048576" });
    expect(c.maxZipBytes).toBe(1048576);
  });

  it("menolak MAX_ZIP_BYTES kosong", () => {
    expect(() => loadConfig({ MONITOR_TOKEN: "x", MAX_ZIP_BYTES: "" })).toThrow(/MAX_ZIP_BYTES/);
  });

  it("menolak MAX_ZIP_BYTES yang bukan angka", () => {
    expect(() => loadConfig({ MONITOR_TOKEN: "x", MAX_ZIP_BYTES: "abc" })).toThrow(/MAX_ZIP_BYTES/);
  });

  it("menolak MAX_ZIP_BYTES nol", () => {
    expect(() => loadConfig({ MONITOR_TOKEN: "x", MAX_ZIP_BYTES: "0" })).toThrow(/MAX_ZIP_BYTES/);
  });

  it("menolak MAX_ZIP_BYTES negatif", () => {
    expect(() => loadConfig({ MONITOR_TOKEN: "x", MAX_ZIP_BYTES: "-5" })).toThrow(/MAX_ZIP_BYTES/);
  });
});
