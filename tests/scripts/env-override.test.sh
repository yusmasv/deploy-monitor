#!/usr/bin/env bash
# Menguji semantik upsert app.env dari run.sh tanpa butuh docker atau VPS.
set -uo pipefail
FAIL=0
check() { if [ "$2" = "$3" ]; then echo "  ok   $1"; else echo "  FAIL $1: '$2' != '$3'"; FAIL=1; fi; }

WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
APP_DIR="$WORK/apps/app"; mkdir -p "$APP_DIR"
export APP_DIR
APP_ENV_FILE="$APP_DIR/app.env"

cat > "$APP_ENV_FILE" <<'EOF'
DATABASE_URL=file:/app/data/prod.db
BETTER_AUTH_SECRET=RAHASIA_LAMA
ADMIN_EMAIL=lama@x.com
export LEGACY=1
EOF
chmod 600 "$APP_ENV_FILE"

cat > "$APP_DIR/app.env.override" <<'EOF'
ADMIN_EMAIL=baru@x.com
SMTP_PASS=p@ss/w&rd$(whoami)`id`
CONN=postgres://u:p@h:5432/db?a=1&b=2
EOF

# apply_env_overrides memanggil info(), yang didefinisikan di run.sh di luar
# rentang yang diambil sed di bawah. Tanpa stub ini, "command not found"
# tercetak ke stderr setiap kali test jalan.
info() { :; }

# Ambil fungsi + blok override langsung dari run.sh yang sebenarnya.
eval "$(sed -n '/^env_set()/,/^}/p' "$(dirname "$0")/../../deploy/run.sh")"
eval "$(sed -n '/^apply_env_overrides()/,/^}/p' "$(dirname "$0")/../../deploy/run.sh")"
apply_env_overrides >/dev/null

get() { grep -m1 "^$1=" "$APP_ENV_FILE" | cut -d= -f2-; }

check "key yang di-override berubah"          "$(get ADMIN_EMAIL)"        "baru@x.com"
check "key yang tidak disebut tetap utuh"     "$(get BETTER_AUTH_SECRET)" "RAHASIA_LAMA"
check "DATABASE_URL tetap utuh"               "$(get DATABASE_URL)"       "file:/app/data/prod.db"
check "nilai berbahaya tersimpan literal"     "$(get SMTP_PASS)"          'p@ss/w&rd$(whoami)`id`'
check "nilai berisi = dan & utuh"             "$(get CONN)"               "postgres://u:p@h:5432/db?a=1&b=2"
check "format export dipertahankan"           "$(grep -c '^export LEGACY=1$' "$APP_ENV_FILE")" "1"
check "tidak ada key duplikat"                "$(grep -c '^ADMIN_EMAIL=' "$APP_ENV_FILE")" "1"
check "perms tetap 600"                       "$(stat -c %a "$APP_ENV_FILE" 2>/dev/null || stat -f %Lp "$APP_ENV_FILE")" "600"
check "file override dihapus"                 "$([ -f "$APP_DIR/app.env.override" ] && echo ada || echo hilang)" "hilang"

[ "$FAIL" -eq 0 ] && echo "SEMUA LULUS" || echo "ADA YANG GAGAL"
exit "$FAIL"
