# Setup Command — Deploy Monitor

Checklist perintah, tanpa penjelasan. Penjelasan tiap langkah ada di `setup.md`.
Ikuti berurutan dari atas ke bawah — jangan lompat, terutama urutan
langkah 8–9 (systemd baru diaktifkan setelah `monitor.env` dan pilihan
firewall selesai).

Ganti setiap `<...>` dengan nilai sungguhan sebelum menjalankan perintahnya.

---

## VPS1 — 1. Pasang Node.js 24

**Dimana:** VPS1, sebagai root, lewat web console.

Debian/Ubuntu:

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
apt-get install -y nodejs
node --version
```

RHEL/CentOS/Fedora (pakai ini, bukan yang di atas):

```bash
curl -fsSL https://rpm.nodesource.com/setup_24.x | bash -
dnf install -y nodejs
node --version
```

`node --version` harus menunjukkan `v24.x` atau lebih baru. Kalau tidak, berhenti — jangan lanjut ke langkah berikutnya.

---

## VPS1 — 2. Clone dan build aplikasi

**Dimana:** VPS1, sebagai root.

Repo publik:

```bash
mkdir -p /srv/monitor
git clone https://github.com/<org>/deploy-monitor.git /srv/monitor/app
cd /srv/monitor/app
npm install
npm run build
```

Repo privat — pakai ini alih-alih baris `git clone` di atas:

```bash
git clone https://<username>:<PAT>@github.com/<org>/deploy-monitor.git /srv/monitor/app
```

Kalau tadi pakai versi privat (dengan PAT di URL), jalankan ini setelah clone selesai:

```bash
git -C /srv/monitor/app remote set-url origin https://github.com/<org>/deploy-monitor.git
```

---

## VPS1 — 3. Buat file unit systemd

**Dimana:** VPS1, sebagai root.

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
OOMScoreAdjust=-500

[Install]
WantedBy=multi-user.target
EOF
```

**Jangan jalankan `systemctl enable`/`start` sekarang.** Aktivasi ada di langkah 8.

---

## VPS1 — 4. Buat token akses

**Dimana:** VPS1 (atau di mana pun, lalu salin hasilnya).

```bash
openssl rand -hex 32
```

Salin hasilnya (64 karakter) — dipakai sebagai `<MONITOR_TOKEN_VALUE>` di langkah berikutnya.

---

## VPS1 — 5. Buat `monitor.env`

**Dimana:** VPS1, sebagai root.

```bash
mkdir -p /srv/monitor
cat > /srv/monitor/monitor.env <<'EOF'
MONITOR_TOKEN=<MONITOR_TOKEN_VALUE>
EXECUTOR=local
DEPLOY_SH=/srv/platform/deploy.sh
UPLOADS_DIR=/srv/uploads
DB_PATH=/srv/monitor/monitor.db
PUBLIC_HOST=<IP_ATAU_HOST_VPS2>
MAX_ZIP_BYTES=209715200
EOF
chmod 600 /srv/monitor/monitor.env
```

**Sebelum menempel dan menjalankan**, ganti dulu di teks perintah di atas: `<MONITOR_TOKEN_VALUE>` dengan hasil langkah 4, dan `<IP_ATAU_HOST_VPS2>` dengan alamat VPS2. `<...>` bukan sintaks shell — kalau dibiarkan apa adanya, `monitor.env` akan berisi teks `<MONITOR_TOKEN_VALUE>` secara literal dan aplikasi gagal start.

---

## VPS1 — 6. Buat direktori upload

**Dimana:** VPS1, sebagai root.

```bash
mkdir -p /srv/uploads
```

---

## VPS2 — 7. Perbarui `run.sh`

**Dimana:** VPS2, sebagai root, lewat web console.

1. Buka `deploy/run.sh` dari repo ini (di komputermu atau di VPS1 hasil clone langkah 2), salin **seluruh isinya**.
2. Di VPS2, jalankan:

```bash
cat > /srv/platform/run.sh <<'EOF'
<TEMPEL_SELURUH_ISI_deploy/run.sh_DI_SINI>
EOF
chmod +x /srv/platform/run.sh
```

**Kutip tunggal pada `'EOF'` wajib** — jangan dihapus. Ganti `<TEMPEL_SELURUH_ISI_deploy/run.sh_DI_SINI>` dengan isi file yang disalin di langkah 1, bukan teks placeholder itu sendiri.

3. Verifikasi sintaks:

```bash
bash -n /srv/platform/run.sh
```

Kalau perintah ini mencetak apa pun (bukan diam), berarti ada kesalahan tempel — ulangi langkah 7 dari awal.

---

## VPS1 — 8. Pilih firewall, lalu aktifkan service

**Dimana:** VPS1, sebagai root. Pilih **salah satu** dari (a) atau (b) sebelum lanjut ke perintah aktivasi di bawah.

**(a) Port 3000 terbuka ke publik** — tidak perlu ubah apa-apa di file unit, langsung ke bagian "Aktifkan" di bawah:

```bash
ufw allow 3000/tcp
```

**(b) Bind ke localhost, akses lewat SSH tunnel** (lebih aman, butuh akses SSH ke VPS1) — edit dulu baris `ExecStart` di `/etc/systemd/system/deploy-monitor.service`:

```
ExecStart=/usr/bin/node node_modules/.bin/next start --hostname 127.0.0.1 --port 3000
```

Lalu dari laptop, tiap kali mau akses:

```bash
ssh -L 3000:127.0.0.1:3000 user@<IP_VPS1>
```

**Aktifkan** (setelah memilih (a) atau (b) di atas):

```bash
systemctl daemon-reload
systemctl enable --now deploy-monitor
```

---

## VPS1 — 9. Verifikasi

**Dimana:** VPS1.

```bash
systemctl status deploy-monitor
```

Harus menunjukkan `active (running)`. Kalau tidak:

```bash
journalctl -u deploy-monitor -f
```

Baca pesan errornya, biasanya salah satu dari: `monitor.env` belum ada/salah path (langkah 5), `MONITOR_TOKEN` kosong atau kurang dari 24 karakter (langkah 4–5), atau `WorkingDirectory` (`/srv/monitor/app`) belum berisi hasil build (langkah 2).

Buka UI:

- Pilihan (a): `http://<IP_VPS1>:3000`
- Pilihan (b): jalankan SSH tunnel dulu (langkah 8), lalu buka `http://localhost:3000`

Login dengan token dari langkah 4.

---

## Opsional — verifikasi tambahan

**Dimana:** VPS1, di dalam `/srv/monitor/app`.

```bash
cd /srv/monitor/app
npm test
npm run test:scripts
npm run test:smoke
```

Ketiganya harus selesai tanpa `FAIL`/exit code bukan-nol. Aman dijalankan kapan pun, termasuk setelah `git pull` versi baru.

---

## Opsional — swap (kalau RAM VPS1 di bawah 4 GB)

**Dimana:** VPS1, sebagai root.

```bash
fallocate -l 2G /swapfile
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
```

---

## Update aplikasi di kemudian hari

**Dimana:** VPS1, di dalam `/srv/monitor/app`.

```bash
cd /srv/monitor/app
git pull
npm install
npm run build
systemctl restart deploy-monitor
```
