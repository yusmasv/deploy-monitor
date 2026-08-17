import { describe, it, expect } from "vitest";
import { detectPhase, detectSummary, stripAnsi, PHASES } from "../lib/phases";

describe("detectPhase", () => {
  it("mengenali penanda dari deploy.sh", () => {
    expect(detectPhase("Cloning repository...")).toBe("source");
    expect(detectPhase("Updating existing repository...")).toBe("source");
    expect(detectPhase("Detecting configuration...")).toBe("configure");
    expect(detectPhase("Building image...")).toBe("build");
    expect(detectPhase("Pushing image...")).toBe("push");
    expect(detectPhase("Shipping app config to runtime host...")).toBe("ship");
    expect(detectPhase("Triggering runtime deployment...")).toBe("runtime");
  });

  it("mengenali penanda dari run.sh", () => {
    expect(detectPhase("Running migration: pnpm migrate")).toBe("migrate");
    expect(detectPhase("Starting application...")).toBe("start");
    expect(detectPhase("Waiting for application...")).toBe("health");
  });

  it("mengabaikan baris biasa", () => {
    expect(detectPhase("Step 5/9 : RUN pnpm build")).toBeNull();
    expect(detectPhase("")).toBeNull();
  });

  it("setiap id yang dikembalikan ada di PHASES", () => {
    const ids = new Set(PHASES.map((p) => p.id));
    for (const line of ["Cloning repository...", "Building image...", "Waiting for application..."]) {
      expect(ids.has(detectPhase(line)!)).toBe(true);
    }
  });
});

describe("detectSummary", () => {
  it("mengambil commit dari deploy.sh:127", () => {
    expect(detectSummary("Commit: a1b2c3d")).toEqual({ sha: "a1b2c3d" });
  });

  it("mengambil image dan port dari blok penutup", () => {
    expect(detectSummary("Image  : 10.8.0.2:5000/kanban:a1b2c3d"))
      .toEqual({ image: "10.8.0.2:5000/kanban:a1b2c3d" });
    expect(detectSummary("Port    : 3000")).toEqual({ appPort: 3000 });
  });

  it("mengabaikan baris lain", () => {
    expect(detectSummary("Branch : main")).toBeNull();
    expect(detectSummary("random")).toBeNull();
  });
});

describe("stripAnsi", () => {
  it("membuang escape sebelum pencocokan", () => {
    expect(stripAnsi("\x1b[0;35mBuilding image...\x1b[0m")).toBe("Building image...");
  });
});
