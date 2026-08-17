#!/usr/bin/env bash
# Menjalankan aplikasi dengan deploy.sh PALSU dan sebuah zip sungguhan, lalu
# memverifikasi API dari ujung ke ujung. Tidak butuh docker maupun VPS.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"; kill "${PID:-0}" 2>/dev/null || true' EXIT

export MONITOR_TOKEN="token-uji"
export EXECUTOR=local
export DEPLOY_SH="$ROOT/tests/fixtures/fake-deploy.sh"
export UPLOADS_DIR="$WORK/uploads"
export DB_PATH="$WORK/monitor.db"
export PUBLIC_HOST="203.0.113.9"
export PORT=3999

mkdir -p "$WORK/src"
printf 'FROM node:22-alpine\nEXPOSE 3000\n' > "$WORK/src/Dockerfile"
(cd "$WORK/src" && zip -qr "$WORK/app.zip" .)

npm run build >/dev/null
npm start -- --port "$PORT" >"$WORK/server.log" 2>&1 & PID=$!

for _ in $(seq 1 40); do
  curl -sf "http://localhost:$PORT/login" >/dev/null 2>&1 && break
  sleep 0.5
done

JAR="$WORK/cookies"
curl -sf -c "$JAR" -X POST "http://localhost:$PORT/api/auth/login" \
  -H 'content-type: application/json' -d '{"token":"token-uji"}' >/dev/null
echo "  ok   login"

ID=$(curl -sf -b "$JAR" -X POST "http://localhost:$PORT/api/deploys" \
  -F "zip=@$WORK/app.zip" -F "project=Uji Coba!" \
  -F 'env=[{"key":"SMTP_PASS","value":"JANGAN_BOCOR"}]' | sed 's/.*"id":"\([^"]*\)".*/\1/')
echo "  ok   deploy dimulai: $ID"

STATUS=""
for _ in $(seq 1 60); do
  STATUS=$(curl -sf -b "$JAR" "http://localhost:$PORT/api/deploys/$ID" | sed 's/.*"status":"\([^"]*\)".*/\1/')
  if [ "$STATUS" = "success" ] || [ "$STATUS" = "failed" ]; then break; fi
  sleep 0.5
done

LOGS=$(curl -sf -b "$JAR" "http://localhost:$PORT/api/deploys/$ID/logs?plain=1")

fail() { echo "  FAIL $1"; exit 1; }

# Setiap pengecekan memakai if/then, BUKAN `cmd && fail` atau `cmd || fail`.
# Dengan `set -e`, sebuah compound `A && B` yang berakhir false mematikan skrip
# tanpa pesan — dan untuk pengecekan NEGATIF di bawah, "tidak ditemukan" justru
# kasus suksesnya. Ditulis dengan `&&`, assertion kebocoran secret akan selalu
# terlihat lulus dengan cara keluar diam-diam sebelum sempat memeriksa apa pun.
if [ "$STATUS" != "success" ]; then fail "status = ${STATUS:-<kosong>}"; fi
if ! echo "$LOGS" | grep -q "Building image"; then fail "penanda fase tidak ada di log"; fi
if echo "$LOGS" | grep -q "JANGAN_BOCOR"; then fail "NILAI ENV BOCOR KE LOG"; fi
if ! echo "$LOGS" | grep -q "SMTP_PASS"; then fail "nama key env tidak dicatat"; fi
if [ ! -d "$UPLOADS_DIR/uji-coba/.git" ]; then fail "nama project tidak dinormalkan jadi 'uji-coba'"; fi
# CATATAN: file override BUKAN ditulis di dalam staging repo project
# ($UPLOADS_DIR/<project>/.env-overrides — desain awal, sebelum Task 10).
# Sejak review Task 10 (Finding 6 + ronde perbaikan berikutnya), file
# override ditulis DI LUAR staging repo manapun, di direktori tetangga
# khusus, dan namanya adalah UUID deploy ini — bukan nama tetap. Lihat
# lib/runner.ts: OVERRIDES_DIR = ".Overrides"; overridePath =
# join(uploadsDir, OVERRIDES_DIR, `${id}.env`). Mengecek path lama di sini
# tidak akan pernah gagal apa pun yang terjadi — itu verifikasi mati yang
# selalu diam-diam lolos, persis kelas masalah yang diperingatkan komentar
# di atas untuk sebab yang berbeda.
if [ -e "$UPLOADS_DIR/.Overrides/$ID.env" ]; then fail "file override tertinggal di direktori .Overrides"; fi

echo "  ok   status sukses, fase tercatat, nilai env tidak bocor, nama dinormalkan"
echo "UJI ASAP LULUS"
