import { cookies, headers } from "next/headers";
import { getConfig } from "./config";
import { COOKIE_NAME, tokenMatches } from "./token";
import { backoffMs, noteFailure, sleep } from "./rate-limit";

export { COOKIE_NAME, tokenMatches };

// Cookie `dm_token` dibandingkan langsung di sini, dan INI gerbang yang
// sebenarnya: penyerang bisa melewati form login sepenuhnya dengan
// `curl -H 'Cookie: dm_token=<tebakan>' /api/deploys`, jalur yang sama sekali
// tidak tersentuh throttle route login. Jadi backoff yang sama dipasang di
// sini juga — tapi HANYA per-IP, TANPA ember global. Fungsi ini jalan di
// SETIAP request terproteksi (bukan hanya percobaan login), jadi ember global
// di sini akan menghukum lalu lintas terautentikasi yang normal dan
// menghidupkan lagi persis risiko DoS yang lib/rate-limit.ts hilangkan.
const KEY_PREFIX = "cookie:";

async function clientKey(): Promise<string> {
  const h = await headers();
  const fwd = h.get("x-forwarded-for")?.split(",")[0]?.trim();
  return KEY_PREFIX + (fwd || h.get("x-real-ip")?.trim() || "unknown");
}

export async function isAuthed(): Promise<boolean> {
  const jar = await cookies();
  const given = jar.get(COOKIE_NAME)?.value ?? "";
  // Cookie yang sah tidak pernah ditunda sedetik pun: jalan pintas sebelum
  // menyentuh header atau ember kegagalan sama sekali.
  if (tokenMatches(getConfig().monitorToken, given)) return true;

  // Beberapa kegagalan pertama juga gratis (FREE_FAILS di lib/rate-limit.ts):
  // pengunjung yang belum login membuka `/` lalu dilempar ke `/login` tidak
  // boleh merasakan penundaan apa pun.
  const key = await clientKey();
  await sleep(backoffMs(key));
  noteFailure(key);
  return false;
}

export async function requireAuth(): Promise<Response | null> {
  if (await isAuthed()) return null;
  return Response.json({ error: "Tidak terautentikasi." }, { status: 401 });
}
