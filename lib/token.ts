import { timingSafeEqual } from "node:crypto";

export const COOKIE_NAME = "dm_token";

/** Perbandingan waktu-tetap, supaya token tidak bisa ditebak byte demi byte. */
export function tokenMatches(expected: string, given: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(given, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
