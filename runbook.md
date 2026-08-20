# Runbook: mendeploy aplikasimu lewat Deploy Monitor

Panduan ini untuk kamu yang mau **mendeploy aplikasimu sendiri** lewat UI
Deploy Monitor yang sudah terpasang dan berjalan. Kalau kamu justru sedang
memasang Deploy Monitor itu sendiri, lihat `setup.md`.

Untuk operasi yang tetap dilakukan manual di VPS2 (log runtime, rollback,
restore database) dan penjelasan lengkap arsitektur `deploy.sh`/`run.sh`,
lihat `deploy/DEPLOYMENT.md`.

## 1. Dependency di dalam zip

Sebelum meng-zip project-mu, pastikan:

- [ ] `Dockerfile` ada di **root** zip — atau di dalam satu folder pembungkus
      tunggal (mis. zip GitHub `my-app-main.zip` yang isinya folder
      `my-app-main/`). Folder pembungkus tunggal itu **dilepas otomatis**;
      kalau ada lebih dari satu item di root, tidak dilepas.
- [ ] `USER` di Dockerfile **numerik**, mis. `USER 1001:1001` — nama user
      (`USER app`) ditolak oleh `deploy.sh` (`deploy/deploy.sh:334`).
- [ ] `EXPOSE <port>` ada di Dockerfile.
- [ ] **devDependencies ikut** di image (`drizzle-kit`, `tsx`, dsb.) — jangan
      build dengan `--prod` atau setara. Migrasi dijalankan di dalam image
      yang sama dengan runtime, jadi kalau tool migrasinya di-prune, migrasi
      gagal.
- [ ] Folder migrasi ikut di zip, termasuk `drizzle/meta/_journal.json` kalau
      memakai Drizzle.
- [ ] `deploy.env` **opsional**. Berbeda dari `DEPLOYMENT.md` versi lama:
      lewat Deploy Monitor, `deploy.env` **tidak perlu di-commit ke git** —
      cukup ikut di dalam zip yang kamu unggah.
- [ ] **Punya script `"seed"` di `package.json`?** Itu akan **otomatis
      dijalankan pada deploy pertama** project ini (tidak pernah pada deploy
      berikutnya — aman untuk data yang sudah ada). Kalau tidak mau ini
      terjadi otomatis, matikan lewat `deploy.env`: `SEED_CMD=""`.

## 2. Perbedaan penting dari alur git lama

| | Alur `deploy.sh` manual (git) | Alur lewat Deploy Monitor (zip) |
|---|---|---|
| Aturan "semua harus di-commit" | Berlaku — file yang belum di-commit tidak terlihat `deploy.sh` | **Tidak berlaku** — apa pun yang ada di dalam zip pasti terpakai, commit atau tidak |
| `.dockerignore` | Berlaku saat build | **Tetap berlaku** — build image tetap memakai `docker build` biasa |

## 3. Langkah deploy

1. **Zip folder project-mu.** Zip isi foldernya (atau satu folder pembungkus
   berisi semuanya) — lihat §1 untuk apa yang harus ada di dalamnya.
   *Hasil:* file `.zip` siap unggah.
2. **Buka UI Deploy Monitor** dan login dengan token yang diberikan admin.
   *Hasil:* halaman utama dengan riwayat deployment dan form "Deploy baru".
3. **Pilih zip** lewat tombol pilih file atau drag-and-drop.
   *Hasil:* nama file dan ukurannya tampil; kolom nama project terisi
   otomatis dari nama file zip.
4. **Isi nama project** — **harus sama persis** dengan deploy sebelumnya
   kalau ini pembaruan dari deploy yang sudah ada. Nama project dinormalisasi
   dulu sebelum dipakai sebagai nama direktori/database: huruf besar/kecil
   **tidak dibedakan** (di-lowercase duluan), dan karakter apa pun di luar
   `a-z`, `0-9`, `.`, `_`, `-` diganti jadi `-`. Konsekuensinya dua arah —
   dan salah satunya berbahaya:
   - Kalau nama barumu **bertabrakan** setelah dinormalisasi dengan project
     yang sudah ada (mis. `MyApp` vs `myapp` — sama persis setelah
     di-lowercase, atau `my app` vs `my-app` — spasi juga jadi `-`), Deploy
     Monitor menganggapnya **project yang sama** dan menimpa direktori data
     serta database yang sudah ada, **diam-diam, tanpa peringatan**.
   - Kalau nama barumu justru **berbeda** setelah dinormalisasi dari yang
     kamu maksud (mis. typo, atau karakter yang tidak terduga ikut
     ter-normalisasi), Deploy Monitor menganggapnya project **baru**:
     `/srv/data/<project>` lama tidak akan terpakai (datamu di sana tidak
     hilang, tapi tidak tersentuh — dan deploy barumu mulai dari database
     kosong, membuatnya *terlihat* seperti data lama hilang).

   Aturan praktisnya: **ketik nama yang persis sama karakter demi karakter**
   seperti deploy sebelumnya — jangan mengandalkan asumsi bahwa beda huruf
   besar/kecil atau tanda baca pasti dianggap berbeda oleh sistem.
   *Hasil:* kolom nama project terisi dan tervalidasi.
5. **Isi env yang perlu diubah** lewat editor variabel environment (opsional
   — lihat §5 untuk semantiknya).
   *Hasil:* daftar key/value yang akan dikirim sebagai override.
6. **Tekan Deploy.**
   *Hasil:* diarahkan ke halaman detail deploy, dengan log streaming
   real-time dan timeline fase (lihat §4).

## 4. Membaca timeline fase

Deploy melewati fase-fase berikut secara berurutan:

| Fase | Artinya |
|---|---|
| Sumber | `deploy.sh` memakai folder hasil ekstraksi zip langsung sebagai source |
| Konfigurasi | Mendeteksi stack, port, perintah migrasi, dsb., lalu menerapkan override dari `deploy.env`/env yang kamu isi |
| Build | `docker build` — **paling sering gagal**: `Dockerfile not found`, error build stack-mu, atau `USER` bukan angka |
| Push | Image di-push ke registry VPS1 |
| Kirim Config | Config hasil deteksi (dan override env-mu) dikirim ke VPS2 |
| Runtime | `run.sh` mulai dijalankan di VPS2 |
| Migrasi | **Paling sering gagal kedua**: perintah migrasi dijalankan di dalam image; gagal kalau tool migrasi hilang, atau `MIGRATE_CMD` tidak ketahuan |
| Start | Container baru dijalankan |
| Health Check | Menunggu aplikasi menjawab HTTP; kalau tidak sehat dalam batas waktu, deploy dianggap gagal walau container sempat jalan |

Build dan Migrasi adalah dua fase yang paling sering menjadi titik kegagalan
— lihat tabel di §6 untuk gejala dan solusinya.

## 5. Env var

Env var yang kamu isi di form **hanya menimpa key yang kamu sebutkan** — ini
override per-key, bukan mengganti seluruh file `app.env` di VPS2. Semantiknya:

- **Kosongkan form** kalau tidak ada yang mau diubah. Nilai lama yang sudah
  ada di `app.env` VPS2 (dari deploy sebelumnya) **tetap terpakai**, tidak
  hilang atau ter-reset.
- Isi hanya key yang benar-benar ingin kamu ubah nilainya.

Contoh konkret:

```
# app.env di VPS2 sebelum deploy ini:
SMTP_HOST=mail.lama.com
ADMIN_EMAIL=admin@lama.com

# Kamu isi form dengan:
SMTP_HOST=mail.baru.com

# app.env di VPS2 sesudah deploy:
SMTP_HOST=mail.baru.com      <- ditimpa
ADMIN_EMAIL=admin@lama.com   <- tidak disentuh
```

**Peringatan untuk dua key ini** — mengubahnya berdampak langsung dan tidak
bisa dibatalkan begitu saja:

- `BETTER_AUTH_SECRET` (atau `NEXTAUTH_SECRET`/`SECRET_KEY`/dst. tergantung
  stack) — mengubahnya membuat **semua sesi login pengguna langsung tidak
  valid**.
- `DATABASE_URL` — mengubahnya mengarahkan aplikasi ke database lain. Data
  lama tetap ada di `/srv/data/<project>`, tapi akan **terlihat seperti
  hilang** karena aplikasi kini membaca dari tempat lain.

## 6. Kegagalan yang lazim

| Gejala di log | Penyebab | Tindakan |
|---|---|---|
| `Dockerfile not found` | Zip berisi lebih dari satu folder di root sehingga pembungkus tidak dilepas | Zip **isi** foldernya, bukan foldernya |
| `Image USER is '...', which is a name` | `USER app` bukan angka | Ganti jadi `USER 1001:1001` |
| `Found migration files but could not determine how to apply them` | Ada folder migrasi tanpa `MIGRATE_CMD` | Tambahkan `MIGRATE_CMD` di `deploy.env` dalam zip |
| `migrate : <none>` padahal app punya DB | Deteksi gagal | **Hentikan** — lihat `DEPLOYMENT.md` aturan no. 9 |
| `drizzle-kit: not found` | Image di-prune, devDependencies hilang | Jangan `pnpm install --prod` |
| Status `Terputus` | Service monitor restart di tengah deploy | Cek `journalctl -u deploy-monitor`; kemungkinan OOM |
| Deploy diam di `Antri` atau `Berjalan` sangat lama, log tidak bertambah | Tidak ada batas waktu deploy: satu langkah yang menggantung (mis. `docker build` atau `scp` yang tidak pernah selesai) menahan antrian yang cuma punya satu pekerja — deploy berikutnya ikut tertahan di `Antri` | `systemctl restart deploy-monitor`. Deploy yang macet ditandai `Terputus` saat service naik lagi dan antrian bebas kembali; unggah ulang zip-nya. Cek juga `journalctl -u deploy-monitor` untuk penyebab langkah yang menggantung |

## 7. Yang tetap manual di VPS2

Di luar cakupan v1 Deploy Monitor — dilakukan langsung di VPS2, lihat
`deploy/DEPLOYMENT.md` §10 untuk detail lengkapnya (jangan disalin ulang di
sini karena bisa jadi tidak sinkron seiring waktu):

- Melihat log runtime aplikasi (`app.sh <project> logs -f`)
- Rollback lewat `current-image`
- Restore database dari backup
