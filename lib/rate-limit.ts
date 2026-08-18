/**
 * Backoff bersama untuk jalur autentikasi (form login DAN cek cookie).
 *
 * Bentuknya sengaja PENUNDAAN, bukan penguncian. Versi sebelumnya mengunci
 * keras: satu kunci yang melewati batas kegagalan membuat setiap request
 * berikutnya dibalas 429 selama 60 detik. Karena kunci itu harus mencakup
 * ember GLOBAL (tanpa proxy di depan, `x-forwarded-for` DIKENDALIKAN KLIEN,
 * jadi batas per-IP saja bisa dilewati dengan mengganti header tiap request),
 * siapa pun dari internet bisa mengunci OPERATOR yang sah keluar dari satu-
 * satunya panel kendali deploy-nya — cukup 20 request bertoken salah, diulang
 * tiap 60 detik selamanya. Itu DoS baru yang tidak terautentikasi, dan
 * imbalannya kecil: token wajib >= 24 karakter (lib/config.ts) dan setup.md
 * menyuruh membuatnya dengan `openssl rand -hex 32` — 256 bit entropi tidak
 * bisa ditebak lewat jaringan, dengan atau tanpa throttle. Jadi throttle di
 * sini hanya pertahanan berlapis, bukan penahan beban, dan tidak layak
 * ditukar dengan risiko operator terkunci.
 *
 * Karena itu: tidak ada request yang PERNAH ditolak di sini. Kegagalan yang
 * menumpuk hanya memperlambat request berikutnya dari kunci yang sama, dengan
 * batas atas MAX_DELAY_MS yang sengaja rendah — cukup untuk membuat tebakan
 * otomatis jauh lebih lambat daripada satu putaran jaringan, tapi terlalu
 * pendek untuk berfungsi sebagai penolakan layanan bagi siapa pun.
 *
 * Modul ini murni (tidak mengimpor apa pun dari Next) supaya bisa dipakai
 * route handler maupun Server Component, dan bisa diuji tanpa runtime Next.
 * In-memory tanpa Redis: aplikasi ini satu proses, satu operator (spec).
 */

const WINDOW_MS = 5 * 60_000;   // umur hitungan kegagalan
const FREE_FAILS = 3;           // kegagalan awal tidak dihukum sama sekali
const STEP_MS = 250;            // tambahan penundaan tiap kegagalan sesudahnya
const MAX_DELAY_MS = 3000;      // batas atas penundaan — lihat komentar di atas
const MAX_KEYS = 1000;          // batas atas memori kalau IP dipalsukan acak

interface Bucket { fails: number; first: number }

const buckets = new Map<string, Bucket>();

/** Ember yang masih di dalam jendela; yang kedaluwarsa dibuang, bukan dipakai. */
function live(key: string, now: number): Bucket | undefined {
  const b = buckets.get(key);
  if (!b) return undefined;
  if (now - b.first > WINDOW_MS) { buckets.delete(key); return undefined; }
  return b;
}

/** Berapa lama request berikutnya untuk `key` harus ditahan. Tidak pernah menolak. */
export function backoffMs(key: string, now: number = Date.now()): number {
  const b = live(key, now);
  if (!b) return 0;
  return Math.min(Math.max(0, b.fails - FREE_FAILS) * STEP_MS, MAX_DELAY_MS);
}

export function noteFailure(key: string, now: number = Date.now()): void {
  const b = live(key, now) ?? { fails: 0, first: now };
  b.fails++;
  // Sisip ulang di akhir supaya urutan iterasi Map = urutan kegagalan terakhir
  // (LRU); prune di bawah bergantung pada itu.
  buckets.delete(key);
  buckets.set(key, b);
  if (buckets.size > MAX_KEYS) prune(now);
}

/** Login yang sah menghapus beban: operator yang salah ketik lalu berhasil tidak dihukum. */
export function clearFailures(key: string): void {
  buckets.delete(key);
}

function prune(now: number): void {
  for (const [k, b] of buckets) if (now - b.first > WINDOW_MS) buckets.delete(k);
  // Masih penuh berarti kuncinya memang hidup semua — mis. penyerang memalsukan
  // `x-forwarded-for` tiap request. Buang yang paling lama tidak gagal; kunci
  // yang sedang aktif (termasuk ember global route login) selalu disisipkan
  // ulang di akhir, jadi tidak ikut terbuang.
  for (const k of buckets.keys()) {
    if (buckets.size <= MAX_KEYS) break;
    buckets.delete(k);
  }
}

export function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();
}

/** Hanya untuk test: kosongkan state antar-kasus. */
export function resetBuckets(): void {
  buckets.clear();
}
