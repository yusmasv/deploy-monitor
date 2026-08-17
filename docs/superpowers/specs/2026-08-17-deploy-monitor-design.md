# Deploy Monitor — Design

**Tanggal:** 2026-08-17
**Status:** menunggu review

## 1. Masalah

Deployment sekarang dijalankan manual di VPS1 lewat web console:

```bash
/srv/platform/deploy.sh git@github.com:Aisahub/kanban-clone.git stresstest
```

Tiga konsekuensinya:

1. Sumber kode harus berupa repo Git yang sudah di-push. Aturan no. 1 di
   `DEPLOYMENT.md` — "semua yang dibutuhkan deploy harus DI-COMMIT" — ada karena
   `deploy.sh` bekerja dari hasil `git clone` lalu `git clean -fd`. File yang lupa
   di-commit hilang tanpa peringatan.
2. Log hanya terlihat di web console yang sedang dibuka. Tutup tab, log hilang.
3. Env var aplikasi (`app.env` di VPS2) hanya bisa diisi dengan mengetik manual di
   web console VPS2.

Target: aplikasi FE+BE yang menerima **zip + env var**, menjalankan pipeline yang
sudah ada, dan menyiarkan log berwarna secara realtime — dengan riwayat yang
tersimpan.

## 2. Batasan yang membentuk desain

- **Tidak ada password SSH.** Akses ke kedua VPS hanya lewat web console browser
  milik Hostinger. Yang tersedia justru lebih kuat: **root di console**.
- VPS1 = build host (`deploy.sh`). VPS2 = registry + runtime (`run.sh`, `app.sh`).
- VPS1 sudah bisa SSH ke VPS2 tanpa password lewat `/root/.ssh/deploy_key`
  (`deploy.sh:389-400`).

## 3. Keputusan

| # | Keputusan | Alasan |
|---|---|---|
| D1 | Aplikasi jalan **di VPS1**, bukan di laptop | `deploy.sh` dipanggil lokal via `spawn()`. Tidak ada koneksi jaringan yang bisa putus di tengah build. |
| D2 | Abstraksi `Executor` dengan mode `local` + `ssh` | `ssh` khusus untuk `npm run dev` dari laptop. Produksi selalu `local`. |
| D3 | Zip disambungkan lewat **staging git repo** | `deploy.sh` **nol baris berubah** untuk alur zip. Lihat §5. |
| D4 | Auth = **satu shared token** | Port 3000 terbuka ke internet dan deploy berjalan sebagai root. |
| D5 | App **tidak pernah** bicara langsung ke VPS2 | VPS2 tetap urusan `deploy.sh`. Env override numpang jalur `scp` yang sudah ada. |
| D6 | Env override = **upsert per-key** di `run.sh` | Logika penulisan `app.env` tetap satu tempat bersama `env_has`/`env_add`. |
| D7 | **Nilai** env tidak disimpan di DB monitor | Hanya nama key, untuk audit. `app.env` di VPS2 sudah persisten. |

## 4. Arsitektur

```
Browser ──HTTP──►  deploy-monitor (Next.js, systemd, :3000, root)      VPS1
                     │
                     ├─ POST /api/deploys   multipart: zip + project + env
                     │    │
                     │    ├─ intake   validasi + extract → /srv/uploads/<project>
                     │    ├─ staging  git commit --allow-empty
                     │    ├─ envfile  tulis .env-overrides (chmod 600)
                     │    └─ runner   spawn deploy.sh /srv/uploads/<project>
                     │                  └─ stdout/stderr → baris → SQLite + event bus
                     │
                     └─ GET /api/deploys/:id/stream   (SSE)
                                                                        VPS2
                        deploy.sh ──scp──► deploy.env + app.env.override  │
                                  ──ssh──► run.sh ──► upsert app.env ─────┘
```

## 5. Zip → deploy.sh lewat staging repo

`deploy.sh:56-59` sudah mencocokkan `*/*` sebagai repo URL, dan `git clone /path`
valid untuk repo lokal. Jadi alurnya:

```
unzip           → /srv/uploads/kanban-clone/
git init -b main  (sekali)
git commit --allow-empty -m "upload <timestamp>"   (tiap upload)
spawn deploy.sh /srv/uploads/kanban-clone
```

`deploy.sh` lalu berjalan **apa adanya**: `PROJECT` dari `basename`, `SHA` dari
`rev-parse`, `BRANCH` dari `origin/HEAD`.

### Sudah diverifikasi secara empiris

| Skenario | Hasil |
|---|---|
| Upload pertama | `origin/HEAD` → `origin/main`; `show-ref --verify` lolos; SHA valid |
| Upload ulang (file diubah **dan dihapus**) | `fetch --prune` + `reset --hard` + `clean -fdq` mempropagasi penghapusan |
| Upload zip **identik** | `--allow-empty` → SHA baru → tag image baru, tidak tertukar dengan image lama |
| Riwayat | Tiap upload jadi satu commit; diff antar-deploy tersedia gratis |

`--allow-empty` **wajib**: tanpa itu, meng-upload zip yang sama persis membuat
`git commit` exit 1 dan deploy gagal sebelum mulai.

### Normalisasi nama project — jebakan halus

`deploy.sh:70` menormalkan: `tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9._-' '-'`,
lalu buang `-` di akhir. Karena kita mengoper **path** dan `deploy.sh` mengambil
`basename`-nya, nama direktori yang kita buat harus **sudah** kanonik. Kalau app
menormalkan dengan aturan berbeda, `/srv/uploads/<x>` dan `PROJECT` berbeda →
`/srv/data/<project>` lama tidak ketemu → aplikasi kelihatan seperti kehilangan
seluruh datanya.

Aturannya diport persis, dengan test: `normalize(normalize(s)) === normalize(s)`.

## 6. Env override

### Semantik

`run.sh` sekarang hanya punya `env_add` (add-if-missing, tidak pernah menimpa).
Ditambah operasi kedua, dan **urutan menentukan hasil**:

```
1. env_set  (upsert)          ← override dari user, menang
2. env_add  (add-if-missing)  ← autofill run.sh, hanya mengisi sisa
```

Efek yang diinginkan: kalau user mengisi `BETTER_AUTH_SECRET`, `gen_secret()` di
`run.sh:146-148` **tidak pernah jalan** — bukan digenerate lalu ditimpa. Key yang
tidak disebut user tidak tersentuh sama sekali.

### Implementasi (sudah diprototipe & diuji)

```bash
env_set() {
  local tmp; tmp="$(mktemp)"
  grep -vE "^[[:space:]]*(export[[:space:]]+)?$1=" "${APP_ENV_FILE}" > "${tmp}" 2>/dev/null || true
  printf '%s=%s\n' "$1" "$2" >> "${tmp}"
  cat "${tmp}" > "${APP_ENV_FILE}"      # cat, bukan mv — menjaga mode 600 + inode
  rm -f "${tmp}"
}
```

Parsing memakai `${line%%=*}` / `${line#*=}`, **bukan** `eval` atau `source`.

| Uji | Hasil |
|---|---|
| Key disebut user | Baris lama dihapus, nilai baru ditulis |
| Key tidak disebut (`DATABASE_URL`, `BETTER_AUTH_SECRET`) | Utuh |
| Format `export FOO=1` | Dikenali & dipertahankan |
| Nilai `p@ss/w&rd$(whoami)` + backtick | Literal — tidak ada eval, tidak ada sed yang kacau |
| Nilai berisi `=`, `&`, `?` (URL Postgres) | Utuh |
| Nilai kosong | Valid |
| `chmod 600` + inode | Bertahan |
| Autofill sesudahnya | `gen_secret()` di-skip untuk key user |

### Validasi di API

- Key wajib cocok `^[A-Za-z_][A-Za-z0-9_]*$` — juga membuat interpolasi key ke
  dalam regex `grep` di `env_has`/`env_set` aman dari metakarakter.
- Nilai **tidak boleh mengandung newline** — format `env_file` Docker tidak
  mendukungnya. Ditolak dengan pesan jelas.
- Spasi di awal/akhir nilai **di-trim di API**, karena parser `env_file` Docker
  tidak konsisten soal itu. Ditentukan di satu tempat, bukan jadi kejutan.
- Key duplikat dalam satu submit → ditolak.

### Key berbahaya

Diberi peringatan di UI, **tidak diblokir**:

- `BETTER_AUTH_SECRET` / `NEXTAUTH_SECRET` — `DEPLOYMENT.md` §4: "kalau berubah,
  semua session user langsung invalid". Semua user ter-logout.
- `DATABASE_URL` — mengarahkan app ke DB lain; data lama tetap di
  `/srv/data/<project>` dan tampak seperti hilang.

## 7. Perubahan pada script

### `deploy.sh` — +8 baris

Alur zip sendiri butuh **nol** perubahan (§5). Tambahan ini murni untuk env
override, disisipkan di blok "Hand off to the runtime host" (sekitar baris 391):

```bash
if [ -n "${ENV_OVERRIDES_FILE:-}" ] && [ -s "${ENV_OVERRIDES_FILE}" ]; then
  scp "${SSH_OPTS[@]}" "${ENV_OVERRIDES_FILE}" \
    "${RUNTIME_USER}@${RUNTIME_HOST}:${RUNTIME_APPS_DIR}/${PROJECT}/app.env.override"
fi
```

Tanpa `ENV_OVERRIDES_FILE`, `deploy.sh` berperilaku persis seperti sekarang —
pemakaian manual dari console tidak terpengaruh.

### `run.sh` — +25 baris

`env_set()` (di atas) plus blok yang membaca `${APP_DIR}/app.env.override`,
menerapkannya, lalu **menghapus file itu**. Ditempatkan **sebelum** blok autofill
yang sudah ada (`run.sh:140`).

Mencetak **nama key saja**: `app.env: overrode GOOGLE_CLIENT_ID, SMTP_PASS`.
Tidak pernah nilainya — kalau tidak, secret akan tersimpan permanen di SQLite
log viewer ini.

## 8. Komponen aplikasi

| Modul | Tanggung jawab | Bergantung pada |
|---|---|---|
| `lib/executor/` | `exec()` → stream baris, `writeFile()` | — |
| `lib/intake.ts` | Validasi + extract zip dengan aman | — |
| `lib/project.ts` | Normalisasi nama (port dari `deploy.sh:70`) | — |
| `lib/staging.ts` | `git init` / `commit --allow-empty` | executor |
| `lib/envfile.ts` | Validasi + serialisasi override | — |
| `lib/ansi.ts` | ANSI SGR → span berwarna | — |
| `lib/phases.ts` | Baris log → fase deploy | — |
| `lib/runner.ts` | Antrian, spawn, konsumsi stream, tulis DB | semua di atas |
| `lib/db.ts` | SQLite (`better-sqlite3`) | — |
| `lib/bus.ts` | EventEmitter in-process untuk SSE | — |

### Intake zip — permukaan serangan paling serius

App berjalan **sebagai root**. Empat aturan, masing-masing ada test:

1. **Zip-slip** — entry dengan `..` atau path absolut → tolak **seluruh** upload.
   Path hasil resolusi harus tetap di dalam direktori target.
2. **Wrapper dir** — zip umumnya berisi satu folder `myapp/` di root. Kalau
   top-level hanya satu direktori, isinya di-strip satu level; kalau tidak,
   `Dockerfile` tidak ada di root dan `deploy.sh:260` langsung mati.
3. **`.git` di dalam zip** → dibuang, agar tidak bentrok dengan staging repo.
4. **Batas** — ukuran zip, ukuran hasil extract (zip bomb), jumlah entry.

Extract ke direktori temp dulu, baru disinkronkan ke `/srv/uploads/<project>`
(file yang tidak ada di zip dihapus). Zip rusak tidak pernah merusak upload yang
sudah baik.

### Fase deploy

Script sudah mencetak penanda yang konsisten, jadi timeline ala Vercel gratis:

| Penanda di log | Fase |
|---|---|
| `Cloning repository` / `Updating existing repository` | Source |
| `Detecting configuration` | Configure |
| `Building image` | Build |
| `Pushing image` | Push |
| `Shipping app config` | Ship |
| `Triggering runtime deployment` | Runtime |
| `Running migration:` | Migrate |
| `Starting application` | Start |
| `Waiting for application` | Health |

**Keterbatasan yang disengaja:** ini string matching, jadi rapuh kalau teks di
script diubah. Mitigasi: sukses/gagal **selalu** dari exit code, tidak pernah
dari parsing. Fase murni kosmetik — kalau satu penanda meleset, timeline-nya saja
yang tidak maju.

### Log & realtime

Warna sudah gratis: `deploy.sh` memakai `echo -e` dengan ANSI escape tanpa peduli
TTY. Baris mentah disimpan apa adanya; ANSI di-parse jadi span di FE.

Transport **SSE**, bukan WebSocket: satu arah, auto-reconnect bawaan browser,
lolos proxy apa pun. Reconnect memakai `Last-Event-ID` → replay dari SQLite, jadi
refresh di tengah build tidak kehilangan log.

**Antrian: concurrency 1.** Dua `deploy.sh` bersamaan akan berebut
`/srv/builds/<project>` dan saling `reset --hard`.

## 9. Data

```sql
deploys(
  id, project, status, phase, started_at, ended_at, exit_code,
  sha, image, app_port, live_url, zip_name, zip_size, env_keys
)
log_lines(deploy_id, seq, stream, ts, text)   -- text = mentah, ANSI utuh
```

- `status`: `queued | running | success | failed | interrupted`
- `env_keys`: JSON array **nama key saja**, tidak pernah nilainya (D7)
- `live_url`: dirakit dari `PUBLIC_HOST` (env monitor, IP VPS2) + port yang
  di-print `run.sh:425` tiap deploy

## 10. API

| Endpoint | Keterangan |
|---|---|
| `POST /api/auth/login` | Tukar token → cookie httpOnly |
| `POST /api/deploys` | multipart: `zip`, `project`, `env` (JSON array `{key,value}`) |
| `GET /api/deploys` | Daftar, paginated |
| `GET /api/deploys/:id` | Detail + ringkasan |
| `GET /api/deploys/:id/stream` | SSE, hormati `Last-Event-ID` |
| `GET /api/deploys/:id/logs` | Log lengkap (unduh) |

## 11. Konfigurasi

| Env var | Default | Keterangan |
|---|---|---|
| `MONITOR_TOKEN` | — | **Wajib.** Gagal start kalau kosong. |
| `EXECUTOR` | `local` | `local` \| `ssh` |
| `DEPLOY_SH` | `/srv/platform/deploy.sh` | |
| `UPLOADS_DIR` | `/srv/uploads` | |
| `DB_PATH` | `/srv/monitor/monitor.db` | |
| `PUBLIC_HOST` | — | IP VPS2, untuk merakit URL live |
| `MAX_ZIP_BYTES` | 200 MB | |
| `SSH_HOST` / `SSH_USER` / `SSH_KEY` | — | Hanya untuk `EXECUTOR=ssh` |

## 12. UI

Dark mode dulu. Dua kolom: kiri daftar deployment (project, status chip, waktu
relatif), kanan log viewer + timeline fase + kartu ringkasan (commit, image, URL
live). Form upload: drag-drop zip, nama project, dan editor env var (baris
key/value + tombol tempel format `.env` sekaligus).

Log viewer monospace dengan warna asli script — cyan=info, hijau=sukses,
kuning=warning, merah=error, magenta=action. Auto-scroll yang berhenti begitu
user scroll ke atas, plus search dan download.

## 13. Penanganan error

| Kondisi | Perilaku |
|---|---|
| Zip rusak / zip-slip / terlalu besar | Ditolak `400` sebelum menyentuh disk permanen |
| Key env tidak valid / nilai ada newline | Ditolak `400`, sebutkan key yang salah |
| `deploy.sh` exit ≠ 0 | `status=failed`, log disimpan penuh |
| Service restart saat build | Saat boot, semua `running` → `interrupted` |
| Deploy kedua saat satu sedang jalan | Masuk antrian, `status=queued` |
| File override tertinggal | Dihapus di VPS1 setelah deploy (sukses maupun gagal); dihapus di VPS2 oleh `run.sh` |

## 14. Testing

Vitest. Unit: penolakan zip-slip, strip wrapper dir, idempotensi normalisasi nama,
parsing ANSI, deteksi fase, validasi env (key ilegal, newline, duplikat, trim),
serialisasi override.

Integrasi runner: `deploy.sh` **palsu** yang mencetak penanda fase berwarna lalu
keluar dengan exit code tertentu — jadi seluruh test suite jalan tanpa docker,
tanpa VPS, di laptop.

Perubahan `env_set` di `run.sh` diuji dengan harness bash yang menegaskan tabel
di §6.

## 15. Di luar cakupan (v1)

- Rollback lewat UI — sudah ada caranya di `DEPLOYMENT.md` §10 lewat
  `current-image`, dan itu urusan VPS2 (D5)
- Membaca log runtime / status container dari VPS2 (D5)
- Retensi & pembersihan log lama
- Multi-user, siapa men-deploy apa (D4)

## 16. Deliverable

1. Aplikasi (Next.js, FE + BE)
2. Patch untuk `deploy.sh` (+8) dan `run.sh` (+25)
3. `setup.md` — yang harus disesuaikan di VPS1, VPS2, dan aplikasi; seluruhnya
   bisa dikerjakan lewat web console tanpa password SSH
4. `runbook.md` — langkah deploy + dependency yang harus disiapkan pemakai

## 17. Risiko yang diakui

| Risiko | Mitigasi |
|---|---|
| App jalan sebagai root, port terbuka ke internet | Token wajib; `setup.md` menyarankan bind `127.0.0.1` + tunnel, atau firewall per-IP |
| Deteksi fase rapuh terhadap perubahan teks script | Sukses/gagal selalu dari exit code; fase kosmetik |
| Secret transit lewat disk VPS1 | `chmod 600`, dihapus setelah deploy, tidak pernah masuk log maupun DB |
| Instalasi butuh kode sampai ke VPS1 tanpa SSH | `git clone` dari GitHub lewat web console — VPS1 sudah punya git & jaringan |
