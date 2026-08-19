# Deploy Monitor

Aplikasi web untuk mendeploy aplikasi lain lewat unggahan zip, tanpa perlu
akses SSH ke server. Operator mengunggah zip berisi `Dockerfile`, aplikasi
ini mengekstraknya ke folder per-project di build host (VPS1), menjalankan
`deploy.sh` yang sudah ada di sana, dan menyiarkan log build secara
langsung ke browser lewat SSE. Riwayat deploy disimpan di SQLite.

Dijalankan **sebagai root** di build host: siapa pun yang memegang
`MONITOR_TOKEN` bisa menjalankan deploy. Baca `setup.md` §7 sebelum
mengeksposnya ke internet.

Next.js (App Router) + TypeScript. Butuh **Node.js 24+** (memakai
`node:sqlite` bawaan).

## Dokumentasi

| Dokumen | Isi |
|---|---|
| `setup.md` | Memasang Deploy Monitor di VPS1: prasyarat, systemd, `monitor.env`, firewall |
| `runbook.md` | Memakainya: apa yang harus ada di dalam zip, langkah deploy, membaca fase, kegagalan yang lazim |
| `deploy/DEPLOYMENT.md` | `deploy.sh`/`run.sh` yang diorkestrasi aplikasi ini — arsitektur, operasi manual di VPS2, rollback, restore |

## Perintah

```bash
npm test            # unit test (vitest)
npm run test:scripts # verifikasi env override deploy.sh (bash)
npm run test:smoke   # end-to-end dengan deploy.sh palsu, tanpa docker/VPS
npm run build        # build produksi
npm run dev          # development (lihat catatan EXECUTOR=ssh di setup.md)
```
