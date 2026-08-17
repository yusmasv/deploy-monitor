#!/usr/bin/env bash
# Menguji bahwa app.env.override TETAP dihapus meskipun apply_env_overrides
# gagal di tengah jalan (mis. disk penuh / gagal permission saat menulis
# app.env). run.sh berjalan dengan `set -euo pipefail` (lihat run.sh:8), jadi
# kegagalan di dalam fungsi harus tetap membersihkan file override, sesuai
# constraint proyek: file override dihapus baik sukses maupun gagal.
set -uo pipefail
FAIL=0
check() { if [ "$2" = "$3" ]; then echo "  ok   $1"; else echo "  FAIL $1: '$2' != '$3'"; FAIL=1; fi; }

WORK="$(mktemp -d)"
trap 'chmod -R u+w "$WORK" 2>/dev/null; rm -rf "$WORK"' EXIT
APP_DIR="$WORK/apps/app"; mkdir -p "$APP_DIR"
export APP_DIR
APP_ENV_FILE="$APP_DIR/app.env"

cat > "$APP_ENV_FILE" <<'EOF'
DATABASE_URL=file:/app/data/prod.db
EOF
chmod 600 "$APP_ENV_FILE"

cat > "$APP_DIR/app.env.override" <<'EOF'
ADMIN_EMAIL=baru@x.com
EOF

info() { :; }
FUNCS="$(sed -n '/^env_set()/,/^}/p; /^apply_env_overrides()/,/^}/p' "$(dirname "$0")/../../deploy/run.sh")"

# Paksa kegagalan DI TENGAH apply_env_overrides: app.env dibuat read-only
# SEBELUM apply_env_overrides dipanggil, sehingga baris
# `cat "${tmp}" > "${APP_ENV_FILE}"` di dalam env_set gagal dengan
# "Permission denied" -- mensimulasikan skenario nyata dari temuan reviewer
# (disk full / permission issue di VPS2). Dijalankan di subshell dengan
# `set -e` aktif (sama seperti run.sh baris 8) supaya errexit betul-betul
# menyela fungsi di tengah jalan, bukan keluar lewat `return` normal.
chmod 400 "$APP_ENV_FILE"

( set -euo pipefail; eval "$FUNCS"; apply_env_overrides ) >/dev/null 2>&1
SUBSHELL_EXIT=$?

chmod 600 "$APP_ENV_FILE" 2>/dev/null || true

check "subshell keluar gagal (set -e memicu abort di tengah fungsi)" "$( [ "$SUBSHELL_EXIT" -ne 0 ] && echo gagal || echo sukses )" "gagal"
check "file override tetap dihapus meski gagal di tengah"           "$([ -f "$APP_DIR/app.env.override" ] && echo ada || echo hilang)" "hilang"

[ "$FAIL" -eq 0 ] && echo "SEMUA LULUS" || echo "ADA YANG GAGAL"
exit "$FAIL"
