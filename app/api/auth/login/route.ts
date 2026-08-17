import { cookies } from "next/headers";
import { getConfig } from "@/lib/config";
import { COOKIE_NAME, tokenMatches } from "@/lib/auth";

// Throttle percobaan login yang GAGAL. Sederhana dan in-memory: aplikasi ini
// satu proses, satu operator (spec) — tidak perlu Redis. Tujuannya bukan
// membuat brute force mustahil, tapi membuatnya tidak gratis: tanpa ini,
// endpoint ini bisa dicoba secepat jaringan mengizinkan, dari internet, dan
// yang dijaga token ini setara eksekusi kode sebagai root di build host
// (deploy.sh mem-`source` deploy.env dari zip sebagai root).
const WINDOW_MS = 5 * 60_000;   // umur hitungan kegagalan
const LOCK_MS = 60_000;         // lama terkunci setelah batas terlampaui
const MAX_FAILS = 5;            // per kunci (IP)
const MAX_FAILS_GLOBAL = 20;    // lintas semua kunci — lihat GLOBAL di bawah
const MAX_KEYS = 1000;          // batas atas memori kalau IP dipalsukan acak

// Tanpa proxy di depan (setup.md §7 pilihan (a)), `x-forwarded-for` DIKENDALIKAN
// KLIEN: penyerang bisa menggantinya tiap request dan lolos dari kunci per-IP.
// Karena itu ada kunci GLOBAL kedua yang tidak bisa dipalsukan siapa pun.
// Kunci per-IP tetap berguna supaya satu penyerang tidak langsung mengunci
// operator yang sah selama mungkin.
const GLOBAL = "*";

type Bucket = { fails: number; first: number; until: number };
const buckets = new Map<string, Bucket>();

function clientKey(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return fwd || req.headers.get("x-real-ip")?.trim() || "unknown";
}

function lockedUntil(key: string, now: number): number {
  const b = buckets.get(key);
  return b && b.until > now ? b.until : 0;
}

function noteFailure(key: string, max: number, now: number): void {
  if (buckets.size > MAX_KEYS) {
    for (const [k, b] of buckets) if (b.until <= now && now - b.first > WINDOW_MS) buckets.delete(k);
  }
  const prev = buckets.get(key);
  const b = prev && now - prev.first <= WINDOW_MS ? prev : { fails: 0, first: now, until: 0 };
  b.fails++;
  if (b.fails >= max) { b.fails = 0; b.first = now; b.until = now + LOCK_MS; }
  buckets.set(key, b);
}

export async function POST(req: Request) {
  const now = Date.now();
  const key = clientKey(req);
  const until = Math.max(lockedUntil(key, now), lockedUntil(GLOBAL, now));
  if (until) {
    const detik = Math.ceil((until - now) / 1000);
    return Response.json(
      { error: `Terlalu banyak percobaan login yang gagal. Coba lagi dalam ${detik} detik.` },
      { status: 429, headers: { "retry-after": String(detik) } },
    );
  }

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
    noteFailure(key, MAX_FAILS, now);
    noteFailure(GLOBAL, MAX_FAILS_GLOBAL, now);
    return Response.json({ error: "Token salah." }, { status: 401 });
  }

  // Login sah menghapus hitungan — operator yang salah ketik beberapa kali
  // lalu berhasil tidak boleh terus membawa beban itu.
  buckets.delete(key);
  buckets.delete(GLOBAL);

  const jar = await cookies();
  jar.set(COOKIE_NAME, token, {
    httpOnly: true, sameSite: "lax", path: "/", maxAge: 60 * 60 * 24 * 30,
  });
  return Response.json({ ok: true });
}
