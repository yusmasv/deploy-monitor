import { describe, it, expect, beforeEach } from "vitest";
import { backoffMs, clearFailures, noteFailure, resetBuckets, sleep } from "../lib/rate-limit";

const T0 = 1_700_000_000_000;

describe("backoff kegagalan autentikasi", () => {
  beforeEach(() => resetBuckets());

  it("tidak menunda kunci yang belum pernah gagal", () => {
    expect(backoffMs("a", T0)).toBe(0);
  });

  it("membiarkan beberapa kegagalan pertama gratis", () => {
    // Pengunjung yang belum login membuka halaman lalu dilempar ke /login
    // tidak boleh merasakan penundaan apa pun.
    noteFailure("a", T0);
    expect(backoffMs("a", T0)).toBe(0);
    noteFailure("a", T0);
    noteFailure("a", T0);
    expect(backoffMs("a", T0)).toBe(0);
  });

  it("menaikkan penundaan setelah kegagalan beruntun", () => {
    for (let i = 0; i < 4; i++) noteFailure("a", T0);
    const empat = backoffMs("a", T0);
    expect(empat).toBeGreaterThan(0);
    noteFailure("a", T0);
    expect(backoffMs("a", T0)).toBeGreaterThan(empat);
  });

  it("membatasi penundaan supaya tidak pernah jadi penolakan layanan", () => {
    for (let i = 0; i < 10_000; i++) noteFailure("a", T0);
    expect(backoffMs("a", T0)).toBeLessThanOrEqual(3000);
  });

  it("tidak mencampur kunci yang berbeda", () => {
    for (let i = 0; i < 20; i++) noteFailure("login:1.2.3.4", T0);
    expect(backoffMs("login:1.2.3.4", T0)).toBeGreaterThan(0);
    expect(backoffMs("login:5.6.7.8", T0)).toBe(0);
    expect(backoffMs("cookie:1.2.3.4", T0)).toBe(0);
  });

  it("melupakan kegagalan setelah jendela lewat", () => {
    for (let i = 0; i < 20; i++) noteFailure("a", T0);
    expect(backoffMs("a", T0 + 5 * 60_000 + 1)).toBe(0);
  });

  it("mereset penundaan setelah login yang sah", () => {
    for (let i = 0; i < 20; i++) noteFailure("a", T0);
    expect(backoffMs("a", T0)).toBeGreaterThan(0);
    clearFailures("a");
    expect(backoffMs("a", T0)).toBe(0);
  });

  it("membatasi jumlah kunci yang disimpan saat IP dipalsukan acak", () => {
    // Kunci yang masih aktif dipertahankan: yang dibuang adalah yang paling
    // lama tidak gagal, bukan penyerang yang sedang mencoba sekarang.
    for (let i = 0; i < 3000; i++) {
      noteFailure(`palsu-${i}`, T0);
      for (let j = 0; j < 5; j++) noteFailure("aktif", T0);
    }
    expect(backoffMs("aktif", T0)).toBeGreaterThan(0);
  });

  it("sleep(0) tidak menunggu putaran timer", async () => {
    const mulai = Date.now();
    await sleep(0);
    expect(Date.now() - mulai).toBeLessThan(50);
  });
});
