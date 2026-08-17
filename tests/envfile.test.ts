import { describe, it, expect } from "vitest";
import { parseDotenv, validateEnv, serializeOverrides, DANGEROUS_KEYS } from "../lib/envfile";

describe("validateEnv", () => {
  it("menerima key yang sah", () => {
    expect(validateEnv([{ key: "SMTP_HOST", value: "x" }, { key: "_A1", value: "" }])).toHaveLength(2);
  });

  it("menolak key yang tidak sah", () => {
    for (const key of ["", "1ABC", "A-B", "A B", "A=B", "A.B", "A$B"]) {
      expect(() => validateEnv([{ key, value: "x" }])).toThrow();
    }
  });

  it("menolak nilai yang mengandung newline — env_file Docker tidak mendukungnya", () => {
    expect(() => validateEnv([{ key: "A", value: "baris1\nbaris2" }])).toThrow(/newline/i);
    expect(() => validateEnv([{ key: "A", value: "a\rb" }])).toThrow(/newline/i);
  });

  it("menolak key duplikat", () => {
    expect(() => validateEnv([{ key: "A", value: "1" }, { key: "A", value: "2" }])).toThrow(/duplikat/i);
  });

  it("men-trim spasi di awal/akhir nilai — parser env_file Docker tidak konsisten", () => {
    expect(validateEnv([{ key: "A", value: "  x  " }])[0].value).toBe("x");
  });

  it("mempertahankan karakter berbahaya apa adanya — nilai tidak pernah di-eval", () => {
    const v = "p@ss/w&rd$(whoami)`id`";
    expect(validateEnv([{ key: "A", value: v }])[0].value).toBe(v);
  });

  it("pesan error tidak pernah membocorkan nilai", () => {
    try {
      validateEnv([{ key: "1BAD", value: "SECRET_BOCOR" }]);
      throw new Error("seharusnya melempar");
    } catch (e) {
      expect(String((e as Error).message)).not.toContain("SECRET_BOCOR");
    }
  });
});

describe("parseDotenv", () => {
  it("mengurai format .env yang lazim", () => {
    expect(parseDotenv(`
# komentar
FOO=bar
export BAZ=qux
URL=postgres://u:p@h:5432/db?a=1&b=2
KOSONG=
    `)).toEqual([
      { key: "FOO", value: "bar" },
      { key: "BAZ", value: "qux" },
      { key: "URL", value: "postgres://u:p@h:5432/db?a=1&b=2" },
      { key: "KOSONG", value: "" },
    ]);
  });

  it("melepas kutip yang membungkus nilai", () => {
    expect(parseDotenv(`A="dikutip"\nB='tunggal'`)).toEqual([
      { key: "A", value: "dikutip" }, { key: "B", value: "tunggal" },
    ]);
  });
});

describe("serializeOverrides", () => {
  it("menulis KEY=VALUE literal, tanpa kutip", () => {
    expect(serializeOverrides([{ key: "A", value: "x y" }, { key: "B", value: "" }]))
      .toBe("A=x y\nB=\n");
  });
});

describe("DANGEROUS_KEYS", () => {
  it("menandai key yang membuat user ter-logout atau data tampak hilang", () => {
    expect(DANGEROUS_KEYS.has("BETTER_AUTH_SECRET")).toBe(true);
    expect(DANGEROUS_KEYS.has("NEXTAUTH_SECRET")).toBe(true);
    expect(DANGEROUS_KEYS.has("DATABASE_URL")).toBe(true);
  });
});
