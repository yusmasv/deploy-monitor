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
});
