import { cookies } from "next/headers";
import { getConfig } from "@/lib/config";
import { COOKIE_NAME, tokenMatches } from "@/lib/auth";
import { backoffMs, clearFailures, noteFailure, sleep } from "@/lib/rate-limit";

// Throttle percobaan login yang GAGAL, dalam bentuk PENUNDAAN — tidak pernah
// penolakan. Alasan lengkap kenapa bukan kunci keras ada di lib/rate-limit.ts;
// ringkasnya: kunci keras di ember GLOBAL bisa dipakai siapa pun dari internet
// untuk mengunci operator yang sah keluar dari panel deploy-nya (DoS baru),
// sementara token >= 24 karakter dari `openssl rand -hex 32` sudah membuat
// tebakan lewat jaringan mustahil. Jadi request paling buruk hanya melambat
// beberapa detik, tidak pernah ditolak.
//
// Tanpa proxy di depan (setup.md §7 pilihan (a)), `x-forwarded-for` DIKENDALIKAN
// KLIEN: penyerang bisa menggantinya tiap request dan lolos dari hitungan
// per-IP. Karena itu ada kunci GLOBAL kedua yang tidak bisa dipalsukan siapa
// pun. Dengan backoff (bukan kunci), ember global aman: efek terburuknya
// beberapa detik penundaan, bukan operator yang terkunci.
const GLOBAL = "login-global";

// Awalan "login:" memisahkan ruang kunci dari jalur cookie di lib/auth.ts —
// salah ketik di form login tidak boleh memperlambat pemuatan halaman — dan
// sekaligus membuat GLOBAL tidak bisa ditabrak lewat `x-forwarded-for` palsu.
function clientKey(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return `login:${fwd || req.headers.get("x-real-ip")?.trim() || "unknown"}`;
}

export async function POST(req: Request) {
  const now = Date.now();
  const key = clientKey(req);
  await sleep(Math.max(backoffMs(key, now), backoffMs(GLOBAL, now)));

  // Body yang bukan JSON valid (terpotong, content-type salah) membuat json()
  // MELEMPAR; tanpa dibungkus, Next membalas halaman error HTML 500 dan klien
  // yang menunggu JSON ikut tersedak.
  let token: string | undefined;
  try {
    ({ token } = (await req.json()) as { token?: string });
  } catch {
    return Response.json({ error: "Gagal membaca isi permintaan." }, { status: 400 });
  }

  if (!token || !tokenMatches(getConfig().monitorToken, token)) {
    noteFailure(key);
    noteFailure(GLOBAL);
    return Response.json({ error: "Token salah." }, { status: 401 });
  }

  // Login sah menghapus hitungan — operator yang salah ketik beberapa kali
  // lalu berhasil tidak boleh terus membawa beban itu.
  clearFailures(key);
  clearFailures(GLOBAL);

  const jar = await cookies();
  jar.set(COOKIE_NAME, token, {
    httpOnly: true, sameSite: "lax", path: "/", maxAge: 60 * 60 * 24 * 30,
  });
  return Response.json({ ok: true });
}
