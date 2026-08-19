# Deployment System

Deploy + migrasi otomatis untuk stack apapun (Next.js, Django, Rails, Laravel, …) lewat Docker.

```bash
./deploy.sh git@github.com:org/app-a.git      # app Next.js A
./deploy.sh git@github.com:org/app-b.git      # app Django B — perintah sama
./deploy.sh app-a                             # deploy ulang, cukup namanya
./deploy.sh app-a dev                         # branch lain
```

Yang diambil otomatis: nama project (dari nama repo), branch default (dari repo),
port (dari `EXPOSE` di image), UID (dari `USER` di image), perintah migrasi (dari repo),
dan secret (di-generate sekali).

## 1. Prinsip utama: SATU image

```
my-app:image
├── .next/            ← hasil build
├── node_modules/     ← TERMASUK devDependencies (drizzle-kit, tsx)
├── drizzle/          ← file migrasi + meta/_journal.json
└── package.json      ← script "migrate"
```

Image yang dipakai untuk **menjalankan app** adalah image yang sama persis yang dipakai untuk
**menjalankan migrasi**. Ini menghapus seluruh kelas error `drizzle-kit: not found`:
migrasi jalan lewat `docker compose run app <MIGRATE_CMD>`, jadi otomatis mewarisi image,
env_file, volume, dan user yang identik dengan app — tidak ada yang perlu disamakan manual.

> Konsekuensinya image lebih besar (devDependencies ikut). Itu trade-off yang disengaja:
> image kecil tapi tidak bisa migrasi = deployment gagal.

## 2. Arsitektur

```
VPS1 (build host)                          VPS2 (runtime host)
─────────────────                          ───────────────────
deploy.sh <repo-url|project> [branch]
  1. git clone / reset --hard
  2. deteksi config, lalu deploy.env menimpa sebagian
  3. docker build  → satu image
  4. baca USER + EXPOSE dari image
  5. docker push   → registry
  6. scp config ────────────────────────►  /srv/apps/<project>/deploy.env
  7. ssh run.sh <project> <sha> ────────►  run.sh
                                             1. docker pull
                                             2. lengkapi app.env (per-key)
                                             3. chown data dir
                                             4. stop container lama
                                             5. backup DB (sqlite)
                                             6. MIGRATE_CMD
                                             7. SEED_CMD (deploy pertama saja)
                                             8. docker compose up -d
                                             9. health check
```

VPS2 **tidak perlu source code sama sekali** — cukup `run.sh` + `app.sh` + `app-stack.yml`
sekali pasang.

### Empat file, nama mirip — jangan tertukar

| File | Lokasi | Dibuat oleh | Tiap deploy |
|---|---|---|---|
| `deploy.sh` | VPS1 `/srv/platform/` | kamu, salin sekali | tidak berubah |
| `deploy.env` | **repo** (di-commit) | kamu, opsional | dibaca sebagai override |
| `deploy.env` | VPS2 `/srv/apps/<p>/` | `deploy.sh`, otomatis | **ditimpa total** |
| `app.env` | VPS2 `/srv/apps/<p>/` | `run.sh`, otomatis | hanya **ditambah** |

Konsekuensinya: mengedit `deploy.env` di VPS2 sia-sia (hilang saat deploy berikutnya).
Ubah perilaku deploy lewat `deploy.env` **di repo**; ubah konfigurasi aplikasi lewat
`app.env` **di VPS2**.

## 3. Auto-detect: apa yang dideteksi dan dari mana

| Nilai | Sumber | Kalau gagal |
|---|---|---|
| Nama project | Nama repo (`Kanban-Clone.git` → `kanban-clone`) | — |
| Branch | `origin/HEAD` milik repo | — |
| `APP_PORT` | `EXPOSE` di image → default per stack | error, minta `APP_PORT` |
| `APP_UID`/`APP_GID` | `USER` di image (`USER 1001:1001`) | error kalau USER berupa nama, bukan angka |
| `MIGRATE_CMD` | script `migrate` di package.json → `drizzle.config.*` → `prisma/` → `manage.py` → `artisan` → `Gemfile` | **error** kalau ada folder migrasi tapi caranya tak ketahuan |
| `DB_KIND` | dependency (`@libsql/client`/`better-sqlite3` → sqlite; `pg`/`mysql2` → external) | default `none` |
| `SECRET_VARS` | dependency (`better-auth` → `BETTER_AUTH_SECRET`, Django → `SECRET_KEY`, …) | kosong |
| `SEED_CMD` | **sengaja tidak pernah dideteksi** — script seed bisa menghapus data | kosong |
| `PUBLIC_URL_VARS` | dependency (`better-auth` → `BETTER_AUTH_URL`, `next-auth` → `NEXTAUTH_URL`) | kosong |
| `PUBLIC_URL` | `deploy.env` → `PUBLIC_HOST` di `platform.env` → IP default-route host | peringatan kalau IP tak terdeteksi |
| `BACKUP_KEEP` | default `1` — backup lama dihapus tiap deploy | — |
| `HEALTH_PATH` | `/`, dan cukup ada jawaban HTTP apapun (404 pun lolos) | — |

Deteksi sengaja **berhenti dengan error, bukan menebak**, pada satu kasus paling berbahaya:
ada file migrasi tapi tidak ketahuan cara menjalankannya. Kalau ditebak lalu salah, deploy akan
"sukses" padahal schema-nya ketinggalan.

Deteksi **selalu** dijalankan. `deploy.env` di repo hanya menimpa kunci yang benar-benar
disebutkan di dalamnya — yang tidak disebut tetap memakai hasil deteksi. Jadi aman mengisi
**hanya baris yang mau diubah**:

```bash
SEED_CMD="pnpm seed"      # aktifkan seed (deteksi sengaja mematikan ini)
HEALTH_PATH=/health       # endpoint sendiri
HEALTH_STRICT=true        # wajib balas 2xx/3xx, bukan sekadar hidup
```

## 4. Apa yang persistent, apa yang diganti

| Lokasi | Isi | Waktu deploy |
|---|---|---|
| `/srv/data/<project>/` | **Data aplikasi** (SQLite, upload) | **Tidak pernah disentuh.** Record lama aman. |
| `/srv/apps/<project>/app.env` | Env vars & secrets | Kunci yang hilang **ditambah**; yang sudah ada tidak disentuh. |
| `/srv/backups/<project>/` | Backup DB otomatis | Hanya **1 snapshot terakhir** disimpan (`BACKUP_KEEP`). |
| Container + image | Kode aplikasi | Diganti tiap deploy. |

Migrasi hanya mengubah **struktur** tabel (`ALTER TABLE`, `CREATE TABLE`), bukan menghapus data.

### `app.env` itu apa?

Bukan data — isinya variabel environment: connection string, secret, API key.
Pengisiannya **per-kunci**, bukan per-file: kamu boleh membuat file itu duluan dan hanya
menulis field yang kamu tentukan sendiri; `run.sh` melengkapi sisanya dan **tidak pernah**
menimpa nilai yang sudah ada.

```bash
# ditambahkan otomatis kalau belum ada
DATABASE_URL=file:/app/data/prod.db
BETTER_AUTH_SECRET=<random 32 byte, dibuat sekali lalu tetap>
```

Secret tidak pernah di-regenerate — kalau berubah, semua session user langsung invalid.
Field lain (`GOOGLE_CLIENT_ID`, `ADMIN_*`, `BETTER_AUTH_URL`) tidak bisa ditebak sistem,
jadi tetap kamu isi sendiri.

## 5. Cara menjalankan — langkah demi langkah

Contoh memakai `kanban-clone`, branch `stresstest`.

### Langkah 1 — siapkan repo (di laptop)

Pastikan yang berikut **ter-commit**, bukan sekadar ada di disk:

```bash
git add Dockerfile .dockerignore drizzle/ deploy.env
git status --short          # pastikan tidak ada '??' untuk file di atas
git commit -m "deployment setup"
git push origin stresstest
```

`deploy.sh` bekerja dari hasil `git clone`, dan menjalankan `git clean -fd` — file yang
belum di-commit **tidak akan terlihat olehnya**, tanpa peringatan apa pun.

### Langkah 2 — pasang script di VPS1 (build host)

```bash
ssh root@VPS1 'mkdir -p /srv/platform /srv/builds'
scp deploy/deploy.sh root@VPS1:/srv/platform/deploy.sh
ssh root@VPS1 'chmod +x /srv/platform/deploy.sh'
```

### Langkah 3 — pasang script di VPS2 (runtime host)

```bash
ssh root@VPS2 'mkdir -p /srv/platform /srv/apps /srv/data /srv/backups'
scp deploy/run.sh deploy/app.sh deploy/app-stack.yml root@VPS2:/srv/platform/
ssh root@VPS2 'chmod +x /srv/platform/run.sh /srv/platform/app.sh'
```

### Langkah 4 — isi `app.env` di VPS2 (disarankan, sebelum deploy pertama)

Boleh dilewati — tapi kalau `ADMIN_EMAIL`/`ADMIN_PASSWORD` belum ada saat deploy pertama,
seed tidak akan membuat akun admin dan kamu tidak bisa login.

```bash
ssh root@VPS2
mkdir -p /srv/apps/kanban-clone
cat > /srv/apps/kanban-clone/app.env <<'EOF'
BETTER_AUTH_URL=https://kanban.example.com
ADMIN_EMAIL=admin@kanban.com
ADMIN_PASSWORD=ganti-password-ini
SUPER_ADMIN_EMAILS=admin@kanban.com
EOF
```

`DATABASE_URL` dan `BETTER_AUTH_SECRET` sengaja tidak ditulis — keduanya ditambahkan
otomatis saat deploy.

`BETTER_AUTH_URL` juga tidak perlu ditulis: kalau `PUBLIC_URL` kosong, `run.sh` memakai
IP default-route VPS2 → `http://<ip>:<port>`. Cukup untuk setup tanpa domain. Urutan
prioritasnya, dari yang paling spesifik:

1. `PUBLIC_URL` di `deploy.env` (repo) — pakai kalau sudah punya domain
2. `PUBLIC_HOST` di `/srv/platform/platform.env` (per-server, berlaku untuk semua project)
3. IP hasil deteksi otomatis

Nilai yang sudah ada di `app.env` tidak pernah ditimpa, jadi kamu selalu bisa menuliskannya
sendiri. `run.sh` mencetak URL yang dipakai beserta asalnya di setiap deploy.

### Langkah 5 — deploy pertama

```bash
ssh root@VPS1
/srv/platform/deploy.sh git@github.com:Aisahub/kanban-clone.git stresstest
```

Yang harus terlihat di output:

```
Detecting configuration...
  stack        : node
  migrate      : pnpm migrate
Applying overrides from repository deploy.env...
  port    : 3000
  migrate : pnpm migrate      ← kalau <none>, migrasi TIDAK jalan. Hentikan.
  seed    : pnpm seed         ← kalau <none>, deploy.env belum ter-commit
  database: sqlite
  BETTER_AUTH_URL: <derived on the runtime host>
Running migration: pnpm migrate
Seeding initial data: pnpm seed
Deployment successful.
```

### Langkah 6 — verifikasi

```bash
ssh root@VPS2
/srv/platform/app.sh kanban-clone logs --tail 30
curl -i http://localhost:3000/health          # harus 200
```

Lalu buka `https://domain-mu/admin/login` dan masuk dengan `ADMIN_EMAIL`/`ADMIN_PASSWORD`.

Kalau langkah 4 dilewati dan akun belum ada: tambahkan `ADMIN_*` ke `app.env` sekarang,
lalu jalankan seed-nya saja (tanpa deploy ulang):

```bash
/srv/platform/app.sh kanban-clone seed
```

### Langkah 7 — deploy berikutnya

```bash
/srv/platform/deploy.sh kanban-clone stresstest    # cukup nama project
```

Data lama aman: DB di-backup dulu, lalu hanya `migrate` yang jalan. `SEED_CMD` tidak
diulang karena penanda `/srv/apps/<project>/.initialized` sudah ada.

### Kalau sebelumnya sudah pernah deploy dengan sistem lama

Bersihkan supaya benar-benar mulai dari nol:

```bash
# VPS2 — hentikan container lama (tanpa bergantung compose file lama)
docker ps  -q --filter "label=com.docker.compose.project=kanban-clone" | xargs -r docker stop
docker ps -aq --filter "label=com.docker.compose.project=kanban-clone" | xargs -r docker rm
rm -rf /srv/data/kanban-clone /srv/apps/kanban-clone /srv/backups/kanban-clone
docker volume ls | grep kanban        # hapus volume bernama kalau ada
docker images --format '{{.Repository}}:{{.Tag}}' | grep ':tools-' | xargs -r docker rmi

# VPS1
rm -rf /srv/builds/kanban-clone
```

---

## 6. Isi file

### `deploy.sh`

```bash
#!/usr/bin/env bash
#
# BUILD HOST (VPS1). Clones the app, builds ONE image containing both the
# runtime and the migration tooling, pushes it, then hands off to run.sh on
# the runtime host.
#
#   ./deploy.sh <repo-url> [branch]     first time (or any time)
#   ./deploy.sh <project>  [branch]     re-deploy something already cloned
#   ./deploy.sh </path/to/folder>       already-prepared source (e.g. Deploy
#                                       Monitor's extracted zip upload) — used
#                                       as-is, no git involved
#
# There is NO per-project file to create on this host: everything app-specific
# comes from deploy.env inside the repo itself.
#
set -euo pipefail

SRV_DIR="${SRV_DIR:-/srv}"
PLATFORM_DIR="${PLATFORM_DIR:-${SRV_DIR}/platform}"
BUILDS_DIR="${BUILDS_DIR:-${SRV_DIR}/builds}"
REGISTRY="${REGISTRY:-10.8.0.2:5000}"
RUNTIME_HOST="${RUNTIME_HOST:-10.8.0.2}"
RUNTIME_USER="${RUNTIME_USER:-root}"
RUNTIME_RUN_SH="${RUNTIME_RUN_SH:-/srv/platform/run.sh}"
RUNTIME_APPS_DIR="${RUNTIME_APPS_DIR:-/srv/apps}"
SSH_KEY="${SSH_KEY:-/root/.ssh/deploy_key}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
MAGENTA='\033[0;35m'
RESET='\033[0m'

info()    { echo -e "${CYAN}$1${RESET}"; }
success() { echo -e "${GREEN}$1${RESET}"; }
warning() { echo -e "${YELLOW}$1${RESET}"; }
error()   { echo -e "${RED}$1${RESET}" >&2; }
action()  { echo -e "${MAGENTA}$1${RESET}"; }

die() { error "$1"; exit 1; }

# ------------------------------------------------------------------
# 1. Arguments
# ------------------------------------------------------------------

TARGET="${1:-}"
BRANCH="${2:-}"

[ -n "${TARGET}" ] || die "Usage: deploy.sh <repo-url|project> [branch]"

for cmd in git docker ssh scp; do
  command -v "${cmd}" >/dev/null 2>&1 || die "Required command not found: ${cmd}"
done

# A repo URL contains a scheme, an SSH colon or a path separator; a bare
# project name never does.
case "${TARGET}" in
  *://*|*@*:*|*/*) REPO_URL="${TARGET}" ;;
  *)               REPO_URL="" ;;
esac

# A local path that exists as a plain directory (no .git inside) is used
# as-is, not cloned. This is how Deploy Monitor hands off an extracted zip
# upload. A local path that IS a git repo (e.g. a bare repo used as a clone
# source) keeps the existing clone-based flow below untouched.
LOCAL_SRC=""
if [ -n "${REPO_URL}" ] && [ -d "${REPO_URL}" ] && [ ! -e "${REPO_URL}/.git" ]; then
  LOCAL_SRC="${REPO_URL}"
  REPO_URL=""
fi

if [ -n "${LOCAL_SRC}" ]; then
  PROJECT="$(basename "${LOCAL_SRC}")"
elif [ -n "${REPO_URL}" ]; then
  # Derive the project name from the repo: git@host:org/my-app.git -> my-app
  PROJECT="$(basename "${REPO_URL}")"
  PROJECT="${PROJECT%.git}"
else
  PROJECT="${TARGET}"
fi

# Lowercase: it becomes a Docker image name and a Compose project name.
PROJECT="$(printf '%s' "${PROJECT}" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9._-' '-')"
PROJECT="${PROJECT%-}"

[ -n "${PROJECT}" ] || die "Could not derive a project name from '${TARGET}'"

SRC="${BUILDS_DIR}/${PROJECT}"

# Re-deploy by name only works once the repo is already on this host.
if [ -z "${LOCAL_SRC}" ] && [ -z "${REPO_URL}" ] && [ ! -d "${SRC}/.git" ]; then
  die "Unknown project '${PROJECT}'. Pass the repository URL the first time:
  deploy.sh git@github.com:org/${PROJECT}.git [branch]"
fi

[ -n "${LOCAL_SRC}" ] && BRANCH="n/a"

echo ""
echo -e "${BLUE}Deploying ${PROJECT}${RESET}"
[ -n "${LOCAL_SRC}" ] || echo "Branch: ${BRANCH:-<repository default>}"
echo ""

# ------------------------------------------------------------------
# 2. Source code
# ------------------------------------------------------------------

if [ -n "${LOCAL_SRC}" ]; then
  info "Using uploaded source..."
  SRC="${LOCAL_SRC}"
elif [ -d "${SRC}/.git" ]; then
  info "Updating existing repository..."

  # Re-pointing an existing checkout at a new URL must not fail the deploy.
  if [ -n "${REPO_URL}" ]; then
    git -C "${SRC}" remote set-url origin "${REPO_URL}"
  fi

  git -C "${SRC}" fetch --prune origin
else
  info "Cloning repository..."
  mkdir -p "${BUILDS_DIR}"
  git clone "${REPO_URL}" "${SRC}"
fi

if [ -z "${LOCAL_SRC}" ]; then
  # No branch given: follow whatever the repository itself calls default.
  if [ -z "${BRANCH}" ]; then
    BRANCH="$(git -C "${SRC}" symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null || true)"
    BRANCH="${BRANCH#origin/}"
    [ -n "${BRANCH}" ] || BRANCH="$(git -C "${SRC}" rev-parse --abbrev-ref HEAD)"
  fi

  git -C "${SRC}" show-ref --verify --quiet "refs/remotes/origin/${BRANCH}" \
    || die "Branch '${BRANCH}' does not exist on origin"

  git -C "${SRC}" checkout -B "${BRANCH}" "origin/${BRANCH}" --quiet
  git -C "${SRC}" reset --hard "origin/${BRANCH}" --quiet
  git -C "${SRC}" clean -fdq
fi

success "Source ready (${BRANCH})."

cd "${SRC}"

# Local uploads have no git history to derive an identifier from — a UTC
# timestamp fills the same role (unique per deploy, sortable, valid as a
# Docker tag). Real git sources keep using the actual commit SHA.
if [ -n "${LOCAL_SRC}" ]; then
  SHA="$(date -u +%Y%m%d-%H%M%S)"
else
  SHA="$(git rev-parse --short HEAD)"
fi
echo ""
info "Commit: ${SHA}"

# ------------------------------------------------------------------
# 3. App config: deploy.env if present, otherwise auto-detected
# ------------------------------------------------------------------

APP_PORT=""
MIGRATE_CMD=""
SEED_CMD=""
DB_KIND=""
DB_FILE=""
DB_URL_VAR=""
BACKUP_KEEP=""
SECRET_VARS=""
PUBLIC_URL=""
PUBLIC_URL_VARS=""
HEALTH_PATH=""
HEALTH_STRICT=""
APP_UID=""
APP_GID=""
DOCKERFILE=""
PORT_FALLBACK=""
DB_EVIDENCE=""

REPO_CONF="${SRC}/deploy.env"

has() { [ -e "${SRC}/$1" ]; }

# Reads one section of package.json without needing node/jq on this host.
pkg_scripts() { sed -n '/"scripts"[[:space:]]*:/,/^[[:space:]]*}/p' "${SRC}/package.json" 2>/dev/null; }
pkg_has_dep() { grep -q "\"$1\"[[:space:]]*:" "${SRC}/package.json" 2>/dev/null; }

detect_config() {
  info "Detecting configuration..."

  local pm="npm"
  if   has pnpm-lock.yaml;    then pm="pnpm"
  elif has yarn.lock;         then pm="yarn"
  elif has bun.lockb || has bun.lock; then pm="bun"
  fi

  local run_prefix="${pm} run"
  [ "${pm}" = "pnpm" ] && run_prefix="pnpm"

  # --- stack + migration command -----------------------------------
  local stack="unknown"
  DB_EVIDENCE="no"

  if has package.json; then
    stack="node"
    PORT_FALLBACK="3000"

    if pkg_scripts | grep -q '"migrate"[[:space:]]*:'; then
      MIGRATE_CMD="${run_prefix} migrate"
    elif has drizzle.config.ts || has drizzle.config.js || has drizzle.config.mjs; then
      MIGRATE_CMD="${pm} exec drizzle-kit migrate"
    elif has prisma/schema.prisma; then
      MIGRATE_CMD="${pm} exec prisma migrate deploy"
    fi

    if has drizzle || has prisma/migrations || has migrations; then
      DB_EVIDENCE="yes"
    fi

    if pkg_has_dep "better-auth"; then
      SECRET_VARS="BETTER_AUTH_SECRET"
      PUBLIC_URL_VARS="BETTER_AUTH_URL"
    elif pkg_has_dep "next-auth"; then
      SECRET_VARS="NEXTAUTH_SECRET"
      PUBLIC_URL_VARS="NEXTAUTH_URL"
    fi

    if pkg_has_dep "pg" || pkg_has_dep "postgres" || pkg_has_dep "mysql2"; then
      DB_KIND="external"
    elif pkg_has_dep "@libsql/client" || pkg_has_dep "better-sqlite3" || pkg_has_dep "sqlite3"; then
      DB_KIND="sqlite"
    fi

  elif has manage.py; then
    stack="django"
    PORT_FALLBACK="8000"
    MIGRATE_CMD="python manage.py migrate --noinput"
    SECRET_VARS="SECRET_KEY"
    DB_KIND="sqlite"
    DB_FILE="db.sqlite3"
    has */migrations && DB_EVIDENCE="yes"

  elif has artisan; then
    stack="laravel"
    PORT_FALLBACK="8000"
    MIGRATE_CMD="php artisan migrate --force"
    SECRET_VARS="APP_KEY"
    has database/migrations && DB_EVIDENCE="yes"

  elif has Gemfile; then
    stack="rails"
    PORT_FALLBACK="3000"
    MIGRATE_CMD="bundle exec rails db:migrate"
    SECRET_VARS="SECRET_KEY_BASE"
    has db/migrate && DB_EVIDENCE="yes"
  fi

  # Seeding is never auto-enabled: a seed script may reset data.
  SEED_CMD=""

  # Any HTTP answer proves the server is listening, which is what a deploy
  # needs to know. Set HEALTH_STRICT=true in deploy.env to demand 2xx/3xx.
  HEALTH_PATH="/"
  HEALTH_STRICT="false"

  echo "  stack        : ${stack}"
  echo "  migrate      : ${MIGRATE_CMD:-<none>}"
}

# Detection always runs first, then deploy.env overrides only the keys it
# actually mentions. Sourcing it *instead* of detecting would silently blank
# out everything it omits — a deploy.env with just SEED_CMD would leave
# MIGRATE_CMD empty and skip migrations entirely.
detect_config

if [ -f "${REPO_CONF}" ]; then
  info "Applying overrides from repository deploy.env..."
  # shellcheck source=/dev/null
  . "${REPO_CONF}"
fi

# Checked after overrides, so a hand-written MIGRATE_CMD counts. Silently
# skipping migrations is the one failure that corrupts production quietly.
if [ "${DB_EVIDENCE:-no}" = "yes" ] && [ -z "${MIGRATE_CMD}" ]; then
  die "Found migration files but could not determine how to apply them.
Set MIGRATE_CMD in deploy.env (see deploy/templates/deploy.env)."
fi

[ -f "${SRC}/${DOCKERFILE:-Dockerfile}" ] || die "Dockerfile not found: ${SRC}/${DOCKERFILE:-Dockerfile}"

# ------------------------------------------------------------------
# 4. Build ONE image (runtime + migration tooling in the same image)
# ------------------------------------------------------------------

IMAGE="${REGISTRY}/${PROJECT}:${SHA}"
LATEST="${REGISTRY}/${PROJECT}:latest"

echo ""
action "Building image..."
echo "Image: ${IMAGE}"

# Plain `docker build` on purpose: `docker compose build` would validate the
# compose file's env_file paths, which do not exist on a fresh clone.
docker build \
  --file "${SRC}/${DOCKERFILE:-Dockerfile}" \
  --tag "${IMAGE}" \
  --tag "${LATEST}" \
  "${SRC}"

success "Image built."

# ------------------------------------------------------------------
# 4b. Fill the remaining values from the image itself
# ------------------------------------------------------------------
# Read from the built image rather than guessed: these are the two settings
# that silently break a deploy when they disagree with reality.

if [ -z "${APP_UID}" ]; then
  IMG_USER="$(docker image inspect --format '{{.Config.User}}' "${IMAGE}" 2>/dev/null || true)"
  case "${IMG_USER}" in
    "")        APP_UID="0";                 APP_GID="0" ;;          # image runs as root
    *:*)       APP_UID="${IMG_USER%%:*}";   APP_GID="${IMG_USER##*:}" ;;
    *)         APP_UID="${IMG_USER}";       APP_GID="${IMG_USER}" ;;
  esac
  # A named user (USER app) cannot be chowned by number on the host.
  case "${APP_UID}" in
    ''|*[!0-9]*) die "Image USER is '${IMG_USER}', which is a name, not a UID.
Use a numeric USER in the Dockerfile (e.g. USER 1001:1001) or set APP_UID/APP_GID in deploy.env." ;;
  esac
fi

# Priority: deploy.env > the image's own EXPOSE > the stack's conventional port.
if [ -z "${APP_PORT}" ]; then
  APP_PORT="$(docker image inspect --format '{{range $p,$_ := .Config.ExposedPorts}}{{$p}}{{break}}{{end}}' "${IMAGE}" 2>/dev/null || true)"
  APP_PORT="${APP_PORT%%/*}"
fi
[ -n "${APP_PORT}" ] || APP_PORT="${PORT_FALLBACK}"
case "${APP_PORT}" in
  ''|*[!0-9]*) die "Could not determine the app port. Add EXPOSE to the Dockerfile, or APP_PORT to deploy.env." ;;
esac

# The public URL is compared byte-for-byte against the browser's Origin header
# by auth libraries, so a trailing slash or a missing scheme silently becomes
# "invalid origin" at login time. Fail here instead.
if [ -n "${PUBLIC_URL}" ]; then
  case "${PUBLIC_URL}" in
    http://*|https://*) ;;
    *) die "PUBLIC_URL must start with http:// or https:// (got '${PUBLIC_URL}')." ;;
  esac
  PUBLIC_URL="${PUBLIC_URL%/}"
fi

# Defaults for anything still unset, whether detected or hand-written.
DB_KIND="${DB_KIND:-none}"
DB_FILE="${DB_FILE:-prod.db}"
DB_URL_VAR="${DB_URL_VAR:-DATABASE_URL}"
BACKUP_KEEP="${BACKUP_KEEP:-1}"
HEALTH_PATH="${HEALTH_PATH-/}"
HEALTH_STRICT="${HEALTH_STRICT:-false}"

RESOLVED_CONF="$(mktemp)"
trap 'rm -f "${RESOLVED_CONF}"' EXIT

cat > "${RESOLVED_CONF}" <<EOF
# Resolved by deploy.sh for ${PROJECT} @ ${SHA}. Do not edit here — edit
# deploy.env in the repository (it overrides every value below).
APP_PORT=${APP_PORT}
HEALTH_PATH="${HEALTH_PATH}"
HEALTH_STRICT=${HEALTH_STRICT}
MIGRATE_CMD="${MIGRATE_CMD}"
SEED_CMD="${SEED_CMD}"
DB_KIND=${DB_KIND}
DB_FILE=${DB_FILE}
DB_URL_VAR=${DB_URL_VAR}
BACKUP_KEEP=${BACKUP_KEEP}
SECRET_VARS="${SECRET_VARS}"
PUBLIC_URL="${PUBLIC_URL}"
PUBLIC_URL_VARS="${PUBLIC_URL_VARS}"
APP_UID=${APP_UID}
APP_GID=${APP_GID}
EOF

echo ""
info "Configuration:"
echo "  port    : ${APP_PORT}"
echo "  user    : ${APP_UID}:${APP_GID}"
echo "  migrate : ${MIGRATE_CMD:-<none>}"
echo "  seed    : ${SEED_CMD:-<none>}"
echo "  database: ${DB_KIND}"
echo "  health  : ${HEALTH_PATH:-<container state only>}"
if [ -n "${PUBLIC_URL_VARS}" ]; then
  echo "  ${PUBLIC_URL_VARS}: ${PUBLIC_URL:-<derived on the runtime host>}"
fi

if [ "${DB_KIND}" = "external" ]; then
  warning "External database detected — put its connection string in app.env on the runtime host."
fi

# ------------------------------------------------------------------
# 5. Push
# ------------------------------------------------------------------

echo ""
action "Pushing image..."

docker push "${IMAGE}"
docker push "${LATEST}"

success "Image pushed: ${IMAGE}"

# ------------------------------------------------------------------
# 6. Hand off to the runtime host
# ------------------------------------------------------------------

echo ""
action "Shipping app config to runtime host..."

SSH_OPTS=(-i "${SSH_KEY}" -o StrictHostKeyChecking=accept-new)

ssh "${SSH_OPTS[@]}" "${RUNTIME_USER}@${RUNTIME_HOST}" "mkdir -p '${RUNTIME_APPS_DIR}/${PROJECT}'"
scp "${SSH_OPTS[@]}" "${RESOLVED_CONF}" "${RUNTIME_USER}@${RUNTIME_HOST}:${RUNTIME_APPS_DIR}/${PROJECT}/deploy.env"

success "Config shipped."

# Opsional: env override dari deploy-monitor. Tanpa ENV_OVERRIDES_FILE, blok ini
# tidak melakukan apa pun dan deploy.sh berperilaku persis seperti sebelumnya —
# pemakaian manual dari console tidak terpengaruh.
if [ -n "${ENV_OVERRIDES_FILE:-}" ] && [ -s "${ENV_OVERRIDES_FILE}" ]; then
  action "Shipping env overrides..."
  scp "${SSH_OPTS[@]}" "${ENV_OVERRIDES_FILE}" \
    "${RUNTIME_USER}@${RUNTIME_HOST}:${RUNTIME_APPS_DIR}/${PROJECT}/app.env.override"
  success "Env overrides shipped."
fi

echo ""
action "Triggering runtime deployment..."

ssh "${SSH_OPTS[@]}" "${RUNTIME_USER}@${RUNTIME_HOST}" \
  "${RUNTIME_RUN_SH} '${PROJECT}' '${SHA}'"

# ------------------------------------------------------------------
# 7. Done
# ------------------------------------------------------------------

echo ""
success "Deployment completed."
echo "Project: ${PROJECT}"
echo "Branch : ${BRANCH}"
echo "Commit : ${SHA}"
echo "Image  : ${IMAGE}"
echo ""
```

### `run.sh`

```bash
#!/usr/bin/env bash
#
# RUNTIME HOST (VPS2). Pulls the image, runs migrations inside that same
# image, then starts the app. No source code needed on this host.
#
#   ./run.sh <project> <sha>
#
set -euo pipefail

SRV_DIR="${SRV_DIR:-/srv}"
PLATFORM_DIR="${PLATFORM_DIR:-${SRV_DIR}/platform}"
REGISTRY="${REGISTRY:-10.8.0.2:5000}"
COMPOSE_FILE="${COMPOSE_FILE:-${PLATFORM_DIR}/app-stack.yml}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
MAGENTA='\033[0;35m'
RESET='\033[0m'

info()    { echo -e "${CYAN}$1${RESET}"; }
success() { echo -e "${GREEN}$1${RESET}"; }
warning() { echo -e "${YELLOW}$1${RESET}"; }
error()   { echo -e "${RED}$1${RESET}" >&2; }
action()  { echo -e "${MAGENTA}$1${RESET}"; }

die() { error "$1"; exit 1; }

# ------------------------------------------------------------------
# 1. Arguments + config
# ------------------------------------------------------------------

PROJECT="${1:-}"
SHA="${2:-}"

[ -n "${PROJECT}" ] || die "Usage: run.sh <project> <sha>"
[ -n "${SHA}" ]     || die "Usage: run.sh <project> <sha>"

command -v docker >/dev/null 2>&1 || die "docker not found"
docker compose version >/dev/null 2>&1 || die "docker compose (v2) not found"
[ -f "${COMPOSE_FILE}" ] || die "Missing compose file: ${COMPOSE_FILE}"

APP_DIR="${SRV_DIR}/apps/${PROJECT}"
DATA_DIR="${SRV_DIR}/data/${PROJECT}"
BACKUP_DIR="${SRV_DIR}/backups/${PROJECT}"

APP_CONF="${APP_DIR}/deploy.env"
[ -f "${APP_CONF}" ] || die "Missing ${APP_CONF} (deploy.sh ships this automatically)"

APP_PORT=""
MIGRATE_CMD=""
SEED_CMD=""
DB_KIND=""
DB_FILE=""
DB_URL_VAR=""
BACKUP_KEEP=""
SECRET_VARS=""
PUBLIC_URL=""
PUBLIC_URL_VARS=""
HEALTH_PATH=""
HEALTH_STRICT=""
APP_UID=""
APP_GID=""
# shellcheck source=/dev/null
. "${APP_CONF}"

APP_PORT="${APP_PORT:-3000}"
# 0 is a valid value (image runs as root), so :- must not be used here.
APP_UID="${APP_UID-1001}"
APP_GID="${APP_GID-1001}"
DB_KIND="${DB_KIND:-none}"
DB_FILE="${DB_FILE:-app.db}"
HEALTH_STRICT="${HEALTH_STRICT:-false}"
# How many database backups to retain. 1 = only the pre-migration snapshot of
# the deploy that is running now.
BACKUP_KEEP="${BACKUP_KEEP:-1}"

IMAGE="${REGISTRY}/${PROJECT}:${SHA}"

# Environment variables for the app (connection strings, secrets, API keys).
# NOT application data — data lives in DATA_DIR and is never touched by a
# deploy. Generated once, on first deploy, then owned by you: later deploys
# read it but never rewrite it.
APP_ENV_FILE="${APP_DIR}/app.env"

# Everything the compose file interpolates:
export PROJECT IMAGE APP_PORT DATA_DIR APP_ENV_FILE APP_UID APP_GID

COMPOSE=(docker compose -p "${PROJECT}" -f "${COMPOSE_FILE}")

echo ""
echo -e "${BLUE}Deploying ${PROJECT}${RESET}"
echo "Image: ${IMAGE}"
echo ""

# ------------------------------------------------------------------
# 2. Host directories
# ------------------------------------------------------------------

mkdir -p "${APP_DIR}" "${DATA_DIR}" "${BACKUP_DIR}"

gen_secret() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -base64 32 | tr -d '\n'
  else
    head -c 32 /dev/urandom | base64 | tr -d '\n'
  fi
}

# Written once. Everything here is derivable from deploy.env, so a first deploy
# needs no manual step; anything the app additionally needs (OAuth keys, SMTP,
# ...) you append yourself afterwards and no deploy will clobber it.
# Per-key, not whole-file: a value you wrote yourself is never touched, and a
# value that is missing gets filled in — so you can pre-create app.env with only
# the one or two settings you care about and still get a working DATABASE_URL
# and secrets. Anything added here is added exactly once, ever.
env_has() {
  grep -qE "^[[:space:]]*(export[[:space:]]+)?$1=" "${APP_ENV_FILE}" 2>/dev/null
}

env_add() {
  printf '%s=%s\n' "$1" "$2" >> "${APP_ENV_FILE}"
  ADDED="${ADDED}${ADDED:+, }$1"
}

if [ ! -f "${APP_ENV_FILE}" ]; then
  info "Creating ${APP_ENV_FILE}"
  {
    echo "# Created on first deploy. Edit freely — deploys only ever ADD missing"
    echo "# keys here, never modify or remove one you set."
    echo "# Application DATA lives in ${DATA_DIR} and is independent of this file."
  } > "${APP_ENV_FILE}"
fi

# Holds secrets, and env_file is read by the Docker daemon as root.
chmod 600 "${APP_ENV_FILE}"

ADDED=""

if [ "${DB_KIND}" = "sqlite" ] && ! env_has "${DB_URL_VAR}"; then
  env_add "${DB_URL_VAR}" "file:/app/data/${DB_FILE}"
fi

for var in ${SECRET_VARS}; do
  env_has "${var}" || env_add "${var}" "$(gen_secret)"
done

# The URL the browser actually uses. Auth libraries compare it byte-for-byte
# against the Origin header, so it has to be right; resolved from the most
# specific source available:
#   1. PUBLIC_URL   — deploy.env in the repo (a real domain)
#   2. PUBLIC_HOST  — platform.env on THIS host, shared by every project
#   3. this host's default-route IP, so a no-domain setup still works
PUBLIC_SCHEME=""
PUBLIC_HOST=""
PLATFORM_CONF="${PLATFORM_DIR}/platform.env"
if [ -f "${PLATFORM_CONF}" ]; then
  # shellcheck source=/dev/null
  . "${PLATFORM_CONF}"
fi

detect_host_ip() {
  # The address on the interface that reaches the internet — on a plain VPS
  # that is the address browsers connect to.
  if command -v ip >/dev/null 2>&1; then
    ip route get 1.1.1.1 2>/dev/null |
      awk '{ for (i = 1; i < NF; i++) if ($i == "src") { print $(i + 1); exit } }'
  elif command -v hostname >/dev/null 2>&1; then
    hostname -I 2>/dev/null | awk '{ print $1 }'
  fi
}

PUBLIC_URL_SOURCE="deploy.env"

if [ -z "${PUBLIC_URL}" ] && [ -n "${PUBLIC_URL_VARS}" ]; then
  if [ -z "${PUBLIC_HOST}" ]; then
    PUBLIC_HOST="$(detect_host_ip || true)"
    PUBLIC_URL_SOURCE="detected IP"
  else
    PUBLIC_URL_SOURCE="${PLATFORM_CONF}"
  fi

  if [ -n "${PUBLIC_HOST}" ]; then
    case "${PUBLIC_SCHEME:-http}:${APP_PORT}" in
      http:80|https:443) PUBLIC_URL="${PUBLIC_SCHEME:-http}://${PUBLIC_HOST}" ;;
      *)                 PUBLIC_URL="${PUBLIC_SCHEME:-http}://${PUBLIC_HOST}:${APP_PORT}" ;;
    esac
  fi
fi

for var in ${PUBLIC_URL_VARS}; do
  if [ -n "${PUBLIC_URL}" ]; then
    if ! env_has "${var}"; then
      env_add "${var}" "${PUBLIC_URL}"
      info "${var}=${PUBLIC_URL} (${PUBLIC_URL_SOURCE})"
      if [ "${PUBLIC_URL_SOURCE}" != "deploy.env" ]; then
        info "  Browsing via a different address? Set PUBLIC_URL in deploy.env or"
        info "  PUBLIC_HOST in ${PLATFORM_CONF}, or edit ${APP_ENV_FILE}."
      fi
    fi
  elif ! env_has "${var}"; then
    warning "${var} is not set and this host's address could not be detected."
    warning "Add ${var} to ${APP_ENV_FILE} — login fails with \"invalid origin\" until then."
  fi
done

if [ -n "${ADDED}" ]; then
  info "app.env: added ${ADDED}"
fi

if [ "${DB_KIND}" = "external" ] && ! env_has "${DB_URL_VAR}"; then
  warning "DB_KIND=external — add ${DB_URL_VAR} to ${APP_ENV_FILE} yourself."
fi

# The container runs as APP_UID:APP_GID. A bind-mounted host directory keeps
# the HOST's ownership, which shadows whatever the image set up — without this
# the container cannot create or write its database file.
if [ "$(id -u)" -eq 0 ]; then
  chown -R "${APP_UID}:${APP_GID}" "${DATA_DIR}"
else
  warning "Not running as root — skipping chown of ${DATA_DIR}."
fi

# ------------------------------------------------------------------
# 3. Pull image
# ------------------------------------------------------------------

info "Pulling image..."
docker pull "${IMAGE}"
success "Image pulled."

# ------------------------------------------------------------------
# 4. First deploy or not?
# ------------------------------------------------------------------

INIT_MARKER="${APP_DIR}/.initialized"

if [ -f "${INIT_MARKER}" ]; then
  FIRST_DEPLOY="false"
  info "Existing installation detected — data will be preserved."
else
  FIRST_DEPLOY="true"
  warning "First deploy for this project."
fi

# ------------------------------------------------------------------
# 5. Stop the old container before touching the database
# ------------------------------------------------------------------
# SQLite allows a single writer: migrating while the old container still holds
# the file risks "database is locked" or a half-applied migration.

echo ""
action "Stopping current container (if any)..."
"${COMPOSE[@]}" stop app >/dev/null 2>&1 || true
success "Stopped."

# ------------------------------------------------------------------
# 6. Backup (file-based databases only)
# ------------------------------------------------------------------

DB_PATH="${DATA_DIR}/${DB_FILE}"

if [ "${DB_KIND}" = "sqlite" ] && [ -f "${DB_PATH}" ]; then
  TS="$(date +%Y%m%d-%H%M%S)"
  BACKUP_FILE="${BACKUP_DIR}/${DB_FILE%.db}-${TS}.db"

  echo ""
  action "Backing up database..."

  if command -v sqlite3 >/dev/null 2>&1; then
    sqlite3 "${DB_PATH}" ".backup '${BACKUP_FILE}'"
  else
    # sqlite3 is not installed on every host; a plain copy is safe here
    # because the app container is already stopped.
    cp "${DB_PATH}" "${BACKUP_FILE}"
  fi

  success "Backup created: ${BACKUP_FILE}"

  # Keep only the newest BACKUP_KEEP files, so a database that grows over time
  # cannot fill the disk one deploy at a time. The timestamp in the name sorts
  # chronologically, so plain glob order is oldest-first.
  shopt -s nullglob
  ALL_BACKUPS=( "${BACKUP_DIR}/${DB_FILE%.db}"-*.db )
  shopt -u nullglob

  if [ "${#ALL_BACKUPS[@]}" -gt "${BACKUP_KEEP}" ]; then
    PRUNE=$(( ${#ALL_BACKUPS[@]} - BACKUP_KEEP ))
    for old in "${ALL_BACKUPS[@]:0:PRUNE}"; do
      rm -f "${old}"
    done
    info "Pruned ${PRUNE} old backup(s), keeping ${BACKUP_KEEP}."
  fi
fi

# ------------------------------------------------------------------
# 7. Migrate
# ------------------------------------------------------------------
# Runs inside the SAME image as the app via `compose run`, so it inherits the
# identical env_file, volumes and user — nothing to keep in sync by hand.

run_in_app() {
  "${COMPOSE[@]}" run --rm --no-deps --entrypoint sh app -c "$1"
}

if [ -n "${MIGRATE_CMD}" ]; then
  echo ""
  action "Running migration: ${MIGRATE_CMD}"

  if ! run_in_app "${MIGRATE_CMD}"; then
    error "Migration failed. The app was NOT started."
    if [ -n "${BACKUP_FILE:-}" ]; then
      error "Restore with: cp '${BACKUP_FILE}' '${DB_PATH}'"
    fi
    exit 1
  fi

  success "Migration completed."
else
  warning "MIGRATE_CMD is empty — skipping migration."
fi

# ------------------------------------------------------------------
# 8. Seed (first deploy only)
# ------------------------------------------------------------------

if [ "${FIRST_DEPLOY}" = "true" ] && [ -n "${SEED_CMD}" ]; then
  echo ""
  action "Seeding initial data: ${SEED_CMD}"

  if ! run_in_app "${SEED_CMD}"; then
    error "Seed failed. The app was NOT started."
    exit 1
  fi

  success "Seed completed."
fi

# ------------------------------------------------------------------
# 9. Start
# ------------------------------------------------------------------

echo ""
action "Starting application..."
"${COMPOSE[@]}" up -d app
success "Container started."

# ------------------------------------------------------------------
# 10. Health check
# ------------------------------------------------------------------

echo ""
info "Waiting for application..."

HTTP_TOOL=""
if command -v curl >/dev/null 2>&1; then
  HTTP_TOOL="curl"
elif command -v wget >/dev/null 2>&1; then
  HTTP_TOOL="wget"
fi

if [ -n "${HEALTH_PATH}" ] && [ -z "${HTTP_TOOL}" ]; then
  warning "Neither curl nor wget available — falling back to container state."
  HEALTH_PATH=""
fi

# Always called from an `if`, so a failed probe never trips `set -e`.
# Lenient by default: any HTTP reply (even 404) proves the server is listening,
# which is what a deploy needs to know without knowing the app's routes.
# HEALTH_STRICT=true additionally demands a non-error status.
probe() {
  case "${HTTP_TOOL}:${HEALTH_STRICT}" in
    curl:true)  curl -fsS "$1" >/dev/null 2>&1 ;;
    curl:*)     curl -sS -o /dev/null "$1" >/dev/null 2>&1 ;;
    wget:true)  wget -q -O /dev/null "$1" ;;
    wget:*)     wget -q -O /dev/null "$1" || [ $? -eq 8 ] ;;
    *)          return 1 ;;
  esac
}

OK=0

if [ -z "${HEALTH_PATH}" ]; then
  # No HTTP probe configured: accept the container still running after a beat.
  sleep 5
  if [ -n "$("${COMPOSE[@]}" ps -q app 2>/dev/null)" ]; then OK=1; fi
else
  for _ in $(seq 1 30); do
    # A container that already exited will never become healthy — fail fast.
    if [ -z "$("${COMPOSE[@]}" ps -q app 2>/dev/null)" ]; then
      error "Container exited during startup."
      break
    fi

    if probe "http://localhost:${APP_PORT}${HEALTH_PATH}"; then
      OK=1
      break
    fi

    sleep 2
  done
fi

if [ "${OK}" -ne 1 ]; then
  echo ""
  error "Application unhealthy."
  echo ""
  "${COMPOSE[@]}" logs --tail 50 app || true
  exit 1
fi

# Only now is this installation known-good.
touch "${INIT_MARKER}"

# Remember which image is live so app.sh (and a rollback) can find it without
# the caller having to know the SHA.
echo "${IMAGE}" > "${APP_DIR}/current-image"

echo ""
success "Deployment successful."
echo "Project : ${PROJECT}"
echo "Image   : ${IMAGE}"
echo "Port    : ${APP_PORT}"
if [ "${FIRST_DEPLOY}" = "true" ]; then
  echo "Database: initialized"
else
  echo "Database: migrated"
fi
echo ""
```

### `app.sh`

```bash
#!/usr/bin/env bash
#
# RUNTIME HOST (VPS2). Operate a deployed app without deploying it.
#
#   app.sh <project> run <command...>   one-off command in the app image
#   app.sh <project> seed               re-run SEED_CMD (e.g. after editing app.env)
#   app.sh <project> restart            recreate the container with the current app.env
#   app.sh <project> logs [args...]     tail logs
#   app.sh <project> compose <args...>  escape hatch: raw docker compose
#
# app-stack.yml interpolates six variables. Setting them by hand is easy to get
# wrong — forget one and Compose aborts with "$X unset" — so this script
# reconstructs them from the files run.sh already wrote.
#
set -euo pipefail

SRV_DIR="${SRV_DIR:-/srv}"
PLATFORM_DIR="${PLATFORM_DIR:-${SRV_DIR}/platform}"
COMPOSE_FILE="${COMPOSE_FILE:-${PLATFORM_DIR}/app-stack.yml}"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; MAGENTA='\033[0;35m'; RESET='\033[0m'
success() { echo -e "${GREEN}$1${RESET}"; }
warning() { echo -e "${YELLOW}$1${RESET}"; }
error()   { echo -e "${RED}$1${RESET}" >&2; }
action()  { echo -e "${MAGENTA}$1${RESET}"; }
die() { error "$1"; exit 1; }

PROJECT="${1:-}"
ACTION="${2:-}"
[ -n "${PROJECT}" ] && [ -n "${ACTION}" ] || die \
  "Usage: app.sh <project> run|seed|restart|logs|compose [args...]"
shift 2

APP_DIR="${SRV_DIR}/apps/${PROJECT}"
DATA_DIR="${SRV_DIR}/data/${PROJECT}"
APP_ENV_FILE="${APP_DIR}/app.env"
APP_CONF="${APP_DIR}/deploy.env"

[ -f "${COMPOSE_FILE}" ] || die "Missing compose file: ${COMPOSE_FILE}"
[ -f "${APP_CONF}" ]     || die "Unknown project '${PROJECT}' (no ${APP_CONF}). Deploy it first."
[ -f "${APP_ENV_FILE}" ] || die "Missing ${APP_ENV_FILE}. Deploy it first."

APP_PORT=""; APP_UID=""; APP_GID=""; SEED_CMD=""
# shellcheck source=/dev/null
. "${APP_CONF}"

APP_PORT="${APP_PORT:-3000}"
APP_UID="${APP_UID-1001}"
APP_GID="${APP_GID-1001}"

# The live image, recorded by run.sh on its last successful deploy.
if [ -f "${APP_DIR}/current-image" ]; then
  IMAGE="$(cat "${APP_DIR}/current-image")"
else
  die "No ${APP_DIR}/current-image — deploy once with run.sh before using app.sh."
fi

export PROJECT IMAGE APP_PORT DATA_DIR APP_ENV_FILE APP_UID APP_GID

COMPOSE=(docker compose -p "${PROJECT}" -f "${COMPOSE_FILE}")

case "${ACTION}" in
  run)
    [ $# -gt 0 ] || die "Usage: app.sh ${PROJECT} run <command...>"
    action "Running in ${IMAGE}: $*"
    "${COMPOSE[@]}" run --rm --no-deps --entrypoint sh app -c "$*"
    ;;

  seed)
    [ -n "${SEED_CMD}" ] || die "SEED_CMD is empty in ${APP_CONF} — nothing to run."
    action "Running in ${IMAGE}: ${SEED_CMD}"
    # Reads the CURRENT app.env, so adding ADMIN_EMAIL/ADMIN_PASSWORD there and
    # running this is enough — no redeploy needed.
    "${COMPOSE[@]}" run --rm --no-deps --entrypoint sh app -c "${SEED_CMD}"
    success "Seed finished."
    ;;

  restart)
    # Container environment is fixed at creation time: a plain `docker restart`
    # would keep the OLD app.env values. Recreating is the only way to pick up
    # an edited app.env.
    action "Recreating ${PROJECT} with the current app.env..."
    "${COMPOSE[@]}" up -d --force-recreate app
    success "Recreated."
    ;;

  logs)
    "${COMPOSE[@]}" logs "$@" app
    ;;

  compose)
    "${COMPOSE[@]}" "$@"
    ;;

  *)
    die "Unknown action '${ACTION}'. Use: run | seed | restart | logs | compose"
    ;;
esac
```

### `app-stack.yml`

```yaml
# Generic, stack-agnostic runtime stack. Lives on the runtime host at
# /srv/platform/app-stack.yml and is reused by EVERY project — nothing in here
# is app-specific. run.sh exports the variables below before invoking it.
#
# Only one service: the migration step runs as `compose run app <cmd>`, so it
# reuses this exact image, env_file, volume and user by construction.

services:
  app:
    image: ${IMAGE}
    restart: unless-stopped

    # Must match the UID/GID the image's user was created with, and the
    # ownership run.sh applies to DATA_DIR. Mismatch = "Permission denied"
    # the moment the app touches its data directory.
    user: "${APP_UID}:${APP_GID}"

    ports:
      - "${APP_PORT}:${APP_PORT}"

    environment:
      # Apps that read a port from the environment (Next.js, Rails, many
      # others) bind correctly without any per-project override.
      PORT: "${APP_PORT}"

    # Secrets and connection strings. Created empty by run.sh on first deploy,
    # then edited by hand on the runtime host; deploys never overwrite it.
    env_file:
      - ${APP_ENV_FILE}

    # Persistent state (SQLite file, uploads, ...). Host path, so backups and
    # inspection do not require entering the container.
    volumes:
      - ${DATA_DIR}:/app/data
```

### `deploy.env`

```bash
# OPTIONAL. deploy.sh auto-detects all of this from the repo and the built
# image; add this file to your repo root only to override a detected value or
# to enable something detection deliberately leaves off (SEED_CMD).
#
# Every key is independent: keep the two lines you care about, delete the rest.
# Plain shell assignments — no spaces around `=`.
#
# Contains NO secrets. Secrets live in app.env on the runtime host.

# Normally NOT needed: read automatically from the image's EXPOSE instruction.
APP_PORT=3000

# HTTP path polled after start to decide the deploy succeeded.
# Leave empty ("") to only check that the container stays up.
HEALTH_PATH=/health

# Applied on EVERY deploy, before the app starts. Must be idempotent.
# Leave empty ("") for apps with no database.
#   Next.js + Drizzle : "pnpm migrate"
#   Django            : "python manage.py migrate --noinput"
#   Rails             : "bundle exec rails db:migrate"
#   Laravel           : "php artisan migrate --force"
MIGRATE_CMD="pnpm migrate"

# Runs ONCE, on the first successful deploy only. Leave empty ("") to skip.
SEED_CMD="pnpm seed"

# sqlite -> run.sh backs up DB_FILE before every migration.
# external | none -> no backup (managed by your DB server).
DB_KIND=sqlite

# File name inside the data volume. Only used when DB_KIND=sqlite.
DB_FILE=prod.db

# How many old database backups to keep (default 1 = hanya snapshot terakhir).
BACKUP_KEEP=1

# Which env var receives the generated SQLite path on first deploy.
# Drizzle/Prisma/Rails use DATABASE_URL; override for anything else.
DB_URL_VAR=DATABASE_URL

# Secrets generated ONCE on first deploy (random, then persisted in app.env and
# never regenerated — regenerating would invalidate every session/cookie).
# Space-separated. Leave empty ("") if the app needs none.
#   Next.js + better-auth : "BETTER_AUTH_SECRET"
#   Django                : "SECRET_KEY"
#   Rails                 : "SECRET_KEY_BASE"
SECRET_VARS="BETTER_AUTH_SECRET"

# The URL users actually open in the browser, scheme included, no trailing
# slash. Auth libraries compare it byte-for-byte against the Origin header, so
# it cannot be derived from the port — an unset value means every login fails
# with "invalid origin". Which env var receives it is auto-detected
# (better-auth -> BETTER_AUTH_URL, next-auth -> NEXTAUTH_URL); override with
# PUBLIC_URL_VARS if your app reads a different name.
PUBLIC_URL=https://kanban.example.com

# Normally NOT needed: read automatically from the image's USER instruction.
# Set only if the image has no numeric USER and you want a specific owner.
APP_UID=1001
APP_GID=1001

# Optional: alternate Dockerfile path relative to the repo root.
DOCKERFILE=Dockerfile
```

### `platform.env`

```bash
# OPTIONAL, lives on the RUNTIME host at /srv/platform/platform.env.
# Properties of the server itself, shared by every project deployed to it —
# unlike deploy.env (per app, in the repo) and app.env (per app, secrets).
#
# Without this file run.sh uses the host's default-route IP, which is right for
# a plain VPS accessed by IP. Set these when that guess is wrong: behind NAT, on
# a machine with several public addresses, or once you put a domain in front.

# Host browsers connect to. No scheme, no port — those are added automatically.
# PUBLIC_HOST=203.0.113.10

# Set to https only when something in front actually terminates TLS.
# PUBLIC_SCHEME=http
```

### `Dockerfile (Next.js)`

```dockerfile
# Next.js + Drizzle — ONE image that can both serve the app and run migrations.
#
# The whole point: `drizzle-kit` is a devDependency and migrations are files on
# disk. A "lean" production image (pruned node_modules, or Next's standalone
# output on its own) has neither, so `pnpm migrate` inside it fails with
# `drizzle-kit: not found`. This image keeps node_modules + drizzle/ +
# package.json, exactly as the deployment system expects.

FROM node:22-alpine

RUN corepack enable && corepack prepare pnpm@10.15.1 --activate

WORKDIR /app

# Numeric USER (below) is read straight off the built image by deploy.sh and
# used to chown the data volume. A NAME here (USER app) cannot be mapped to a
# host UID and is rejected.
RUN addgroup -g 1001 -S app \
 && adduser -u 1001 -S app -G app

# Copied in one shot so optional files (pnpm-workspace.yaml, .npmrc, ...) never
# break the build. Costs some layer caching; buys a build that always works.
COPY . .

# NOT --prod: drizzle-kit and tsx are devDependencies and are needed at
# migration time, which happens in this same image.
RUN pnpm install --frozen-lockfile

RUN pnpm build

# The bind-mounted data volume is mounted here at runtime.
RUN mkdir -p /app/data && chown -R 1001:1001 /app

USER 1001:1001

# Next.js binds to localhost by default, which is unreachable from outside the
# container. PORT is injected by app-stack.yml.
ENV HOSTNAME=0.0.0.0
EXPOSE 3000

CMD ["pnpm", "start"]
```

### `Dockerfile (Django)`

```dockerfile
# Django — same contract as the Next.js template: ONE image that can both serve
# the app and run `python manage.py migrate`. Proof that the deployment system
# itself is stack-agnostic: only deploy.env changes.

FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

WORKDIR /app

# Numeric USER (below) is read straight off the built image by deploy.sh and
# used to chown the data volume. A NAME here (USER app) cannot be mapped to a
# host UID and is rejected.
RUN groupadd -g 1001 app \
 && useradd -u 1001 -g app -M -s /usr/sbin/nologin app

COPY . .

RUN pip install --no-cache-dir -r requirements.txt

RUN mkdir -p /app/data && chown -R 1001:1001 /app

USER 1001:1001

EXPOSE 8000

# PORT is injected by app-stack.yml. Replace `myproject` with your WSGI module.
CMD ["sh", "-c", "gunicorn myproject.wsgi:application --bind 0.0.0.0:${PORT:-8000}"]
```

### `.dockerignore`

```text
# Keep the build context small — but never exclude anything the migration step
# needs at runtime: drizzle/ (migration SQL + meta/_journal.json), package.json
# and the schema files MUST stay in the image.

node_modules
.next
.git
.github

# Secrets never belong in an image — they arrive via app.env on the host.
.env
.env.*

# Local databases must never leak into the image and shadow the real volume.
*.db
*.db-journal
*.db-wal

*.log
.DS_Store
coverage
```

### `package.json`

```json
{
  "name": "my-app",
  "private": true,
  "packageManager": "pnpm@10.15.1",
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",

    "//generate": "Author-time only. Run locally after changing lib/schema.ts, then COMMIT drizzle/.",
    "generate": "drizzle-kit generate",

    "//migrate": "Deploy-time. MIGRATE_CMD in deploy.env points here. Applies pending files in drizzle/ and records them in __drizzle_migrations.",
    "migrate": "drizzle-kit migrate",

    "//db:push": "DEV ONLY. Never in a deploy: it writes the schema without recording migrations, which makes `migrate` fail afterwards.",
    "db:push": "drizzle-kit push",

    "seed": "tsx scripts/seed.ts"
  },
  "dependencies": {
    "@libsql/client": "^0.17.4",
    "drizzle-orm": "^0.45.2",
    "next": "16.2.6",
    "react": "19.2.4",
    "react-dom": "19.2.4"
  },
  "devDependencies": {
    "drizzle-kit": "^0.31.10",
    "tsx": "^4.22.3",
    "typescript": "^5"
  }
}
```

### `drizzle.config.ts`

```typescript
import { defineConfig } from "drizzle-kit";

// drizzle-kit does not auto-load .env.local — inject it explicitly.
for (const file of [".env", ".env.local"]) {
  try {
    process.loadEnvFile(file);
  } catch {
    // absent in containers, where DATABASE_URL comes from the environment
  }
}

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error("DATABASE_URL is not set.");
}

export default defineConfig({
  schema: ["./lib/schema.ts"],

  // MUST be committed to git and MUST end up inside the image — this folder,
  // plus meta/_journal.json, is what `drizzle-kit migrate` reads at deploy time.
  out: "./drizzle",

  dialect: "turso",
  dbCredentials: { url, authToken: process.env.DATABASE_AUTH_TOKEN?.trim() || undefined },
});
```

---

## 7. Aturan wajib (kalau dilanggar = error)

**1. Semua yang dibutuhkan deploy harus DI-COMMIT.**

```bash
pnpm generate     # setelah ubah lib/schema.ts
git add drizzle/  # WAJIB, termasuk drizzle/meta/_journal.json
git add deploy.env Dockerfile .dockerignore
```

`deploy.sh` bekerja dari hasil `git clone` lalu `git clean -fd`. File yang belum di-commit
tidak terlihat olehnya — `deploy.env` yang lupa di-commit berarti `SEED_CMD` hilang diam-diam
dan DB baru tidak punya akun admin.

**2. `drizzle/` dan `meta/_journal.json` harus konsisten.**

Journal mendaftar migrasi mana yang ada. Kalau ada entri yang file `.sql`-nya terhapus,
`drizzle-kit migrate` **exit 1 tanpa pesan error sama sekali** dan tidak membuat satu tabel pun.
Jangan hapus file `.sql` secara manual — hapus entri journal + snapshot-nya sekalian, lalu
pastikan `pnpm generate` bilang *"No schema changes"*.

**3. `db:push` HARAM di deploy.**

`push` menulis schema tanpa mencatat apapun di tabel `__drizzle_migrations`. Setelah itu
`migrate` mengira belum ada migrasi yang pernah jalan, lalu menjalankan `CREATE TABLE`
untuk tabel yang sudah ada → **`table already exists`, deploy gagal.**
Di sistem ini DB baru dibuat oleh `migrate` sendiri (file `0000_*.sql`), jadi `push` tidak
pernah dibutuhkan di server.

**4. `USER` di Dockerfile harus berupa ANGKA, bukan nama.**

Tulis `USER 1001:1001`, bukan `USER app`. `deploy.sh` membaca UID itu langsung dari image,
lalu `run.sh` melakukan `chown` ke UID yang sama. Nama user tidak bisa dipetakan ke host, dan
mismatch berarti `Permission denied` begitu app menyentuh database.
(Image yang jalan sebagai root juga didukung — UID otomatis jadi `0:0`.)

**5. Secrets tidak boleh masuk image.** `.env*` ada di `.dockerignore`; yang dipakai runtime
adalah `app.env` di VPS2.

**6. Path database harus di dalam volume**, mis. `file:/app/data/prod.db`. Kalau menunjuk ke
luar `/app/data`, datanya hilang tiap container diganti.

**7. `SEED_CMD` harus non-destruktif.** Karena itu deteksi otomatis tidak pernah mengaktifkannya.
Kalau kamu nyalakan lewat `deploy.env`, ingat: dia jalan pada deploy pertama, dan **jalan lagi**
kalau deploy pertama gagal health check lalu diulang. Jangan pakai script yang `DROP`/`DELETE`.

**8. Ubah env = recreate container, bukan restart.** Environment container ditetapkan saat
container dibuat; `docker restart` akan memakai nilai lama. Pakai `app.sh <project> restart`
(yang memakai `--force-recreate`).

**9. Baca baris `migrate :` di output deploy.** Kalau `<none>` padahal aplikasimu punya
database, hentikan deploy — artinya migrasi dilewati dan aplikasi akan jalan di atas DB
tanpa tabel.

## 8. Error yang sudah tidak mungkin terjadi lagi

| Error sebelumnya | Penyebab | Sekarang |
|---|---|---|
| `drizzle-kit: not found` | Image runtime di-prune, devDependencies hilang | Satu image berisi `node_modules` lengkap |
| `tools-<sha>: not found` | Image kedua tidak pernah di-build/push | Tidak ada image kedua sama sekali |
| `cp: can't create '/app/data/prod.db': Permission denied` | Host dir milik root, container jalan sebagai uid 1001 | UID dibaca dari image, lalu `chown` otomatis |
| `env file .env not found` | `docker compose build` memvalidasi `env_file` | Build pakai `docker build` biasa; `app.env` dilengkapi otomatis |
| `table already exists` waktu migrate | DB dibuat pakai `db:push`, tanpa bookkeeping | DB selalu dibuat oleh `migrate` sejak awal |
| `migrate` exit 1 tanpa pesan | Entri journal menunjuk file `.sql` yang hilang | Aturan no. 2 di atas |
| `MIGRATE_CMD is empty — skipping migration` | `deploy.env` di repo **menggantikan** deteksi, bukan menimpanya | Deteksi selalu jalan; `deploy.env` hanya menimpa kunci yang disebut |
| Script berhenti diam-diam | `set -e` kena percobaan health check pertama | Probe dipanggil di dalam `if`, dengan retry |
| Deploy "sukses" padahal container mati | Health check tidak cek state container | Cek `compose ps`, dan print 50 baris log kalau gagal |
| Salah tebak port / lupa `APP_PORT` | Port di-hardcode 3000 | Dibaca dari `EXPOSE` milik image |
| `$IMAGE unset` waktu perintah manual | `app-stack.yml` butuh 6 variabel ter-export | Pakai `app.sh`, bukan `docker compose` langsung |
| `invalid origin` waktu login | `BETTER_AUTH_URL` tidak ada → daftar `trustedOrigins` kosong | Diisi otomatis dari `PUBLIC_URL` / `PUBLIC_HOST` / IP host |

## 9. Kapan perlu bikin `deploy.env`

Hampir tidak pernah. Yang paling sering cuma ini:

```bash
# Aktifkan seed pada deploy pertama (deteksi sengaja mematikannya)
SEED_CMD="pnpm seed"

# Punya endpoint health sendiri dan mau ketat
HEALTH_PATH=/health
HEALTH_STRICT=true

# URL publik → otomatis jadi BETTER_AUTH_URL / NEXTAUTH_URL.
# Hanya perlu kalau sudah punya domain; tanpa ini dipakai IP server otomatis.
PUBLIC_URL=https://kanban.domain.com

# Database eksternal, bukan sqlite
DB_KIND=external
```

## 10. Operasi harian & troubleshooting

Semua lewat `app.sh`. **Jangan** panggil `docker compose -f app-stack.yml` langsung:
file itu butuh `IMAGE`/`DATA_DIR`/`APP_ENV_FILE`/`APP_UID`/`APP_GID`/`APP_PORT` ter-export,
dan Compose berhenti dengan `$X unset` kalau ada satu saja yang kurang. `app.sh` mengisinya
sendiri dari file yang sudah ditulis `run.sh`.

```bash
# log
/srv/platform/app.sh <project> logs -f
/srv/platform/app.sh <project> logs --tail 50

# jalankan perintah apapun di dalam image app (env & volume identik dengan app)
/srv/platform/app.sh <project> run "pnpm exec drizzle-kit migrate"
/srv/platform/app.sh <project> run "pnpm exec tsx scripts/create-admin.ts a@b.com rahasia123"

# jalankan ulang SEED_CMD (mis. setelah menambah ADMIN_* ke app.env)
/srv/platform/app.sh <project> seed

# muat ulang app.env yang baru diedit
/srv/platform/app.sh <project> restart
```

**Rollback ke image lama** — `app.sh` selalu memakai image yang tercatat di
`/srv/apps/<project>/current-image`, jadi cukup ganti isinya:

```bash
docker images '10.8.0.2:5000/<project>'                       # cari SHA lama
echo '10.8.0.2:5000/<project>:<sha-lama>' > /srv/apps/<project>/current-image
/srv/platform/app.sh <project> restart
```

(Deploy berikutnya menimpa `current-image` lagi dengan versi baru.)

**Restore database** dari backup terakhir:

```bash
/srv/platform/app.sh <project> compose stop app
cp /srv/backups/<project>/prod-<timestamp>.db /srv/data/<project>/prod.db
chown 1001:1001 /srv/data/<project>/prod.db     # samakan dengan APP_UID
/srv/platform/app.sh <project> restart
```

**Mulai dari nol** (menghapus SEMUA data project ini):

```bash
docker ps -aq --filter "label=com.docker.compose.project=<project>" | xargs -r docker rm -f
rm -rf /srv/data/<project> /srv/apps/<project> /srv/backups/<project>
```

## 11. Catatan khusus kanban-clone

Kondisi repo saat ini sudah siap:

- `drizzle/` berisi `0000_initial.sql` + `0001_add_users.sql` + `meta/` — konsisten, dan
  `pnpm generate` bilang *"No schema changes"*.
- `Dockerfile` sudah single-image (`USER 1001:1001`, `EXPOSE 3000`, `CMD pnpm start`).
- `next.config.ts` sudah tanpa `output: "standalone"`.
- `deploy.env` berisi `SEED_CMD="pnpm seed"` + `HEALTH_PATH=/health` (sudah di-commit).
  Tanpa `HEALTH_STRICT=true`, deploy dianggap sukses begitu `/health` menjawab apa pun —
  termasuk 500. Tambahkan baris itu kalau mau statusnya wajib 2xx/3xx.
- `scripts/seed.ts` membuat akun admin dari `ADMIN_EMAIL`/`ADMIN_PASSWORD` (idempoten —
  akun yang sudah ada hanya dipastikan `is_admin=true`, password tidak diubah).
- `docker-compose.yml` di root sekarang **khusus dev lokal**, tidak dipakai deploy.

`ensureDatabaseSchema()` di `lib/db.ts` hanya membuat 8 tabel pelengkap (`CREATE TABLE IF NOT
EXISTS`) — tabel inti (`tasks`, `projects`, `user`, `session`, …) **hanya** dibuat oleh migrasi.
Jadi kalau `MIGRATE_CMD` terlewat, seed langsung gagal dan aplikasi tidak akan jalan.

Kalau suatu saat ada DB produksi berisi data asli yang dulu dibuat dengan `db:push`
(tanpa `__drizzle_migrations`), jangan langsung `migrate` — jalankan
`scripts/baseline-migrations.ts` dulu untuk menandai migrasi yang sudah "terpasang".
