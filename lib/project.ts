// Port persis dari deploy.sh:69-71
//   PROJECT="$(printf '%s' "$PROJECT" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9._-' '-')"
//   PROJECT="${PROJECT%-}"
// Kita mengoper PATH ke deploy.sh dan dia mengambil basename-nya, lalu menormalkan
// ULANG. Jadi nama direktori kita harus sudah jadi titik-tetap dari fungsi ini —
// kalau tidak, PROJECT milik deploy.sh berbeda dari nama direktori kita dan
// /srv/data/<project> yang lama tidak akan ditemukan.
export function normalizeProject(raw: string): string {
  let s = raw.toLowerCase().replace(/[^a-z0-9._-]/g, "-");
  // SEMUA tanda hubung di akhir, bukan satu seperti ${PROJECT%-}. Alasannya:
  // hasil fungsi ini dipakai sebagai nama direktori, lalu deploy.sh mengambil
  // basename-nya dan menerapkan ${PROJECT%-} sekali lagi. Kalau kita menyisakan
  // satu tanda hubung, PROJECT milik deploy.sh berbeda dari nama direktori kita.
  s = s.replace(/-+$/, "");

  if (s === "" || s === "." || s === "..") {
    throw new Error(
      `Nama project '${raw}' tidak valid — setelah dinormalkan tidak menyisakan karakter yang bisa dipakai.`,
    );
  }
  return s;
}
