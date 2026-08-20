# Setup: memasang Deploy Monitor

Panduan ini untuk memasang **aplikasi Deploy Monitor** ini sendiri, bukan untuk
mendeploy aplikasi lewatnya (untuk itu, lihat `runbook.md`). Ditulis dengan
asumsi kamu **hanya punya web console** VPS1 dan VPS2 (mis. dari panel
provider), tanpa password SSH ke keduanya.

Untuk hal-hal di luar cakupan dokumen ini — cara kerja `deploy.sh`/`run.sh`
secara detail, operasi harian di VPS2, rollback, restore database — lihat
`deploy/DEPLOYMENT.md`.

## 1. Ringkasan yang berubah

| Host | Apa yang berubah |
|---|---|
| VPS1 (build host) | Pasang aplikasi Deploy Monitor ini + Node.js 24, **dan** ganti `deploy.sh` dengan versi baru (mendukung upload zip tanpa git) |
| VPS2 (runtime host) | Ganti `run.sh` dengan versi baru (mendukung env override per-key) |
| Aplikasi (Deploy Monitor) | Isi `monitor.env` — token, path, dan (opsional) kredensial SSH ke VPS2 |

VPS2 **tidak perlu perubahan lain** selain `run.sh`. `app.sh`, `app-stack.yml`,
dan seluruh isi `/srv/apps`, `/srv/data`, `/srv/backups` tetap seperti biasa.
Di VPS1, cuma `deploy.sh` yang berubah — tidak ada file lain di `/srv/platform`
yang perlu disentuh.

## 2. Prasyarat VPS1

- **Node.js 24 atau lebih baru** — wajib, karena aplikasi ini memakai modul
  bawaan `node:sqlite` untuk menyimpan riwayat deploy.
- `git` — untuk clone repo aplikasi ini.
- `docker` (dengan `docker compose` v2) — dipakai oleh `deploy.sh` yang sudah
  ada di VPS1 ini untuk build & push image.
- `unzip` **tidak diperlukan** — ekstraksi zip yang diunggah lewat UI
  dilakukan di dalam proses Node sendiri, bukan lewat perintah shell.

Pasang Node 24 lewat NodeSource (tempel langsung ke web console, sebagai
root):

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
apt-get install -y nodejs
node --version   # harus menunjukkan v24.x atau lebih baru
```

Kalau VPS1 memakai distro berbasis RPM (RHEL/CentOS/Fedora), ganti dua baris
pertama dengan:

```bash
curl -fsSL https://rpm.nodesource.com/setup_24.x | bash -
dnf install -y nodejs
```

## 3. Memasukkan kode ke VPS1 tanpa SSH

Karena tidak ada akses SSH dari laptop ke VPS1, jalur termudah adalah
`git clone` langsung **di dalam** VPS1 lewat web console — VPS1 sudah punya
`git` (langkah 2) dan akses jaringan keluar untuk menjangkau GitHub.

```bash
mkdir -p /srv/monitor
git clone https://github.com/<org>/deploy-monitor.git /srv/monitor/app
cd /srv/monitor/app
npm install
npm run build
```

**Kalau repo-nya privat**, sisipkan personal access token (PAT) langsung di
URL clone:

```bash
git clone https://<username>:<PAT>@github.com/<org>/deploy-monitor.git /srv/monitor/app
```

Setelah clone berhasil, **hapus token dari remote URL** supaya tidak
tertinggal tersimpan di `.git/config` (yang bisa terbaca siapa pun yang punya
akses ke direktori ini):

```bash
git -C /srv/monitor/app remote set-url origin https://github.com/<org>/deploy-monitor.git
```

Untuk pembaruan aplikasi berikutnya, cukup ulangi `git pull`, `npm install`,
`npm run build`, lalu `systemctl restart deploy-monitor` (unit systemd-nya
dipasang di langkah berikutnya). `git pull` ini **tidak** menyentuh
`/srv/platform/deploy.sh` maupun `/srv/platform/run.sh` — keduanya file
terpisah, bukan bagian dari repo ini. Kalau pembaruan yang kamu tarik
mengubah `deploy/deploy.sh` atau `deploy/run.sh`, ulangi langkah 6 dan/atau
7 secara manual juga.

## 4. Systemd unit

Simpan sebagai `/etc/systemd/system/deploy-monitor.service`, siap tempel:

```bash
cat > /etc/systemd/system/deploy-monitor.service <<'EOF'
[Unit]
Description=Deploy Monitor
After=network-online.target docker.service

[Service]
Type=simple
WorkingDirectory=/srv/monitor/app
EnvironmentFile=/srv/monitor/monitor.env
ExecStart=/usr/bin/node node_modules/.bin/next start --port 3000
Restart=always
RestartSec=3
# Build docker memakan RAM besar. Tanpa ini, monitor bisa jadi korban OOM
# killer tepat saat kamu sedang menonton build berjalan.
OOMScoreAdjust=-500

[Install]
WantedBy=multi-user.target
EOF
```

Kutip tunggal pada `'EOF'` di sini juga sengaja: baris `ExecStart` di atas
tidak punya `${...}`, tapi kebiasaan ini mencegah kesalahan kalau suatu saat
unit-nya diedit menambahkan variabel.

**Jangan aktifkan unit ini dulu.** `ExecStart` di atas memakai `EnvironmentFile`
tanpa awalan `-`, jadi systemd **menolak start** kalau file itu belum ada —
dan `monitor.env` baru dibuat di langkah berikutnya. `ExecStart` juga masih
bisa berubah tergantung pilihan firewall di langkah 8. Aktivasi
(`systemctl daemon-reload` + `enable --now`) ada di akhir langkah 8, setelah
semua prasyaratnya terpenuhi.

## 5. `monitor.env`

Buat `/srv/monitor/monitor.env` — path ini **harus sama persis** dengan
`EnvironmentFile` di unit systemd pada langkah 4:

```bash
mkdir -p /srv/monitor
cat > /srv/monitor/monitor.env <<'EOF'
MONITOR_TOKEN=ganti-dengan-hasil-openssl-di-bawah
EXECUTOR=local
DEPLOY_SH=/srv/platform/deploy.sh
UPLOADS_DIR=/srv/uploads
DB_PATH=/srv/monitor/monitor.db
PUBLIC_HOST=
MAX_ZIP_BYTES=209715200
EOF
chmod 600 /srv/monitor/monitor.env
```

Buat `MONITOR_TOKEN` yang acak dan tempel hasilnya ke atas:

```bash
openssl rand -hex 32
```

Keterangan tiap variabel (semuanya dibaca oleh `lib/config.ts`):

| Variabel | Wajib? | Keterangan |
|---|---|---|
| `MONITOR_TOKEN` | **Wajib** | Aplikasi gagal start kalau kosong **atau kurang dari 24 karakter** — ini juga token login UI (dipakai sebagai cookie), karena aplikasi menjalankan `deploy.sh` sebagai root. `openssl rand -hex 32` di atas menghasilkan 64 karakter, jadi jauh di atas batas. |
| `EXECUTOR` | Tidak (default `local`) | **Produksi selalu `local`** — Deploy Monitor dipasang langsung di VPS1 dan menjalankan `deploy.sh` di sana. `ssh` **hanya untuk pengembangan dari laptop** (`npm run dev`), jangan pernah dipakai produksi — lihat peringatan di bawah tabel. |
| `SSH_HOST` / `SSH_USER` / `SSH_KEY` | Hanya kalau `EXECUTOR=ssh` (development) | Alamat, user, dan path private key untuk SSH ke VPS1 build host. |
| `DEPLOY_SH` | Tidak (default `/srv/platform/deploy.sh`) | Path `deploy.sh` di VPS1 — **harus versi terbaru dari repo ini**, lihat langkah 6. Versi lama (tanpa dukungan folder biasa) membuat SEMUA deploy lewat UI gagal di fase "Cloning repository...". |
| `UPLOADS_DIR` | Tidak (default `/srv/uploads`) | Tempat hasil ekstraksi zip yang diunggah disimpan sebagai folder biasa (satu folder per project). Butuh ruang disk yang cukup untuk source project terbesar yang akan kamu deploy. |
| `DB_PATH` | Tidak (default `/srv/monitor/monitor.db`) | File SQLite riwayat deploy milik aplikasi ini sendiri (bukan database aplikasi yang dideploy). |
| `PUBLIC_HOST` | Tidak | IP atau host VPS2, dipakai untuk merakit URL live yang ditampilkan di UI setelah deploy sukses. |
| `MAX_ZIP_BYTES` | Tidak (default 200 MB) | Batas ukuran zip yang boleh diunggah, dalam byte — **dan sekaligus batas total ukuran isinya setelah di-extract**, karena angka yang sama dipakai untuk kedua pemeriksaan. Jadi zip 50 MB yang mengembang jadi 300 MB tetap ditolak walau file zip-nya sendiri jauh di bawah batas. |

> **`EXECUTOR=ssh` bukan pilihan produksi.** Dalam mode itu `deploy.sh`
> berjalan sebagai anak dari channel SSH, jadi gangguan jaringan sekecil apa
> pun mengirim SIGHUP dan **membunuh build di tengah jalan** — termasuk
> kemungkinan tepat saat langkah migrasi database sedang berjalan, yang bisa
> meninggalkan database setengah termigrasi. Mode ini ada semata untuk
> menjalankan Deploy Monitor dari laptop (`npm run dev`) sambil menguji ke
> VPS1 sungguhan. Produksi memasang Deploy Monitor **di VPS1 itu sendiri**
> dengan `EXECUTOR=local`, sehingga deploy tidak bergantung pada jaringan
> sama sekali (lihat komentar di `lib/executor/ssh.ts`).

Buat juga direktori `UPLOADS_DIR`-nya kalau belum ada:

```bash
mkdir -p /srv/uploads
```

## 6. Memperbarui `deploy.sh` di VPS1

`deploy.sh` di VPS1 adalah script yang sudah ada **sebelum** Deploy Monitor
dipasang — dia bukan bagian dari `git clone` di langkah 3, jadi tidak
otomatis ter-update. Sejak Deploy Monitor mengunggah project sebagai folder
biasa (bukan staging git repo), `deploy.sh` butuh satu penambahan: mode baru
yang menerima folder langsung tanpa `git clone`. **Tanpa langkah ini, semua
deploy lewat UI akan gagal** di fase "Cloning repository..." atau "Updating
existing repository..." dengan pesan `does not appear to be a git
repository` — alur git manual (`deploy.sh <repo-url>` langsung dari CLI)
tetap jalan seperti biasa, jadi kegagalan ini cuma kelihatan lewat UI Deploy
Monitor.

Sama seperti `run.sh` di langkah 7, tempelkan langsung lewat web console
VPS1 (path defaultnya `/srv/platform/deploy.sh` — sesuaikan kalau
`DEPLOY_SH` di `monitor.env` kamu isi beda):

```bash
cat > /srv/platform/deploy.sh <<'EOF'
# ... tempel seluruh isi deploy/deploy.sh versi terbaru dari repo ini di sini ...
EOF
chmod +x /srv/platform/deploy.sh
```

**Kutip tunggal pada `'EOF'` wajib** — alasan yang sama seperti `run.sh` di
langkah 7: tanpa itu, `${...}` di dalam script ikut di-ekspansi shell saat
ini (yang nilainya kosong), dan hasil yang tersimpan rusak.

Verifikasi:

```bash
bash -n /srv/platform/deploy.sh
```

## 7. Memperbarui `run.sh` di VPS2

Deploy Monitor mengirim override env per-key lewat `app.env.override`, yang
dibaca `run.sh` versi baru (lihat `deploy/DEPLOYMENT.md` untuk isi lengkap
`run.sh`). Karena tidak ada SSH dari laptop ke VPS2, tempelkan isinya langsung
lewat web console VPS2:

```bash
cat > /srv/platform/run.sh <<'EOF'
# ... tempel seluruh isi deploy/run.sh versi terbaru dari repo ini di sini ...
EOF
chmod +x /srv/platform/run.sh
```

**Kutip tunggal pada `'EOF'` itu wajib.** Tanpa kutip, shell akan mengekspansi
setiap `${...}` di dalam script (mis. `${APP_PORT}`, `${DATA_DIR}`) sebagai
variabel shell saat ini — yang kosong — sehingga `run.sh` yang tersimpan rusak
total dan tidak akan pernah berjalan benar.

Verifikasi setelah menempel:

```bash
bash -n /srv/platform/run.sh   # cek sintaks, tanpa menjalankannya
```

## 8. Firewall

Dua pilihan untuk port 3000 (port UI Deploy Monitor) di VPS1:

**(a) Buka port 3000 ke publik.** Paling sederhana — cukup buka port di
firewall (`ufw allow 3000/tcp` atau setara). Keamanannya bergantung
**sepenuhnya** pada `MONITOR_TOKEN`: siapa pun yang tahu token bisa login dan
memicu deploy.

Perlu disadari betul untuk pilihan ini: tidak ada TLS di depan aplikasi
(setup ini tidak memasang reverse proxy penerminasi TLS), jadi koneksinya
polos HTTP dan **`MONITOR_TOKEN` melintas dalam bentuk teks terbuka pada
setiap request** — saat login maupun lewat cookie di semua request
sesudahnya. Siapa pun yang bisa mengintip jalur jaringan antara browsermu dan
VPS1 (Wi-Fi publik, jaringan kantor, hop di antaranya) bisa membaca token itu
apa adanya, dan token = kemampuan menjalankan kode sebagai root di VPS1. Ini
alasan kuat memilih pilihan (b) di bawah kalau kamu bisa mengaturnya: lewat
SSH tunnel, seluruh lalu lintas termasuk token terenkripsi oleh SSH dan port
3000 tidak pernah menyentuh internet.

**(b) Bind ke `127.0.0.1`, akses lewat SSH tunnel.** Ubah `ExecStart` di unit
systemd (langkah 4) menjadi `next start --hostname 127.0.0.1 --port 3000`,
lalu dari laptop:

```bash
ssh -L 3000:127.0.0.1:3000 user@VPS1
```

dan buka `http://localhost:3000` di browser laptop.

Aplikasi ini menjalankan `deploy.sh` **sebagai root** (lihat §5), jadi
kompromi pada aplikasi ini setara kompromi penuh VPS1. Kalau kamu punya akses
SSH ke VPS1 (walau tidak ke VPS2), **pilihan (b) lebih aman** — port 3000 sama
sekali tidak diekspos ke internet.

Sekarang semua prasyarat unit systemd sudah terpenuhi — `monitor.env` (§5)
ada, `deploy.sh` di VPS1 (§6) dan `run.sh` di VPS2 (§7) sudah diperbarui,
dan `ExecStart` sudah final
sesuai pilihan firewall di atas. Aktifkan:

```bash
systemctl daemon-reload
systemctl enable --now deploy-monitor
```

## 9. Verifikasi

```bash
systemctl status deploy-monitor
journalctl -u deploy-monitor -f
```

Lalu buka UI (`http://<ip-VPS1>:3000` atau `http://localhost:3000` kalau
lewat tunnel) dan login memakai `MONITOR_TOKEN` yang dibuat di langkah 5.

Kalau kamu ingin memverifikasi lebih dalam (mis. setelah `git pull` versi
baru), repo ini punya tiga lapis pemeriksaan yang bisa dijalankan langsung:
`npm test` (unit test), `npm run test:scripts` (verifikasi `deploy.sh` untuk
env override, termasuk bahwa file berisi secret selalu terhapus walau proses
gagal di tengah), dan `npm run test:smoke` (menjalankan server sungguhan
dengan `deploy.sh` palsu, tanpa butuh docker maupun VPS2).

## 10. Catatan RAM

`docker build` (dipicu `deploy.sh` untuk tiap deploy) bisa memakan RAM besar
tanpa bergantung sama sekali pada aplikasi Deploy Monitor ini — ini sifat
umum build Next.js/Docker di mesin kecil. Kalau VPS1 punya RAM di bawah 4 GB,
tambahkan swap supaya build tidak memicu OOM killer di tengah jalan:

```bash
fallocate -l 2G /swapfile
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
```

Selain build, unggahan itu sendiri juga memakan RAM: seluruh zip dibaca ke
memori dulu, lalu isi hasil ekstraksinya ditahan di memori sebelum ada satu
byte pun ditulis ke disk. Perkirakan **puncak sekitar 2x ukuran zip** untuk
tiap unggahan (zip + isinya, dan keduanya sama-sama dibatasi
`MAX_ZIP_BYTES`) — dengan default 200 MB itu berarti ratusan MB sesaat, di
atas pemakaian `docker build` yang menyusul. Kalau RAM VPS1 tipis, turunkan
`MAX_ZIP_BYTES` di samping menambah swap.
