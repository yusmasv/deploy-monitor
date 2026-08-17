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

# ------------------------------------------------------------------
# 2b. Env override dari deploy-monitor (opsional)
# ------------------------------------------------------------------
# Berbeda dari env_add di bawah: ini MENIMPA nilai yang sudah ada. Dijalankan
# LEBIH DULU supaya autofill sesudahnya melihat key ini sudah terisi dan tidak
# menyentuhnya — khususnya gen_secret(), yang tidak akan pernah jalan untuk key
# yang diisi sendiri oleh user.
env_set() {
  local tmp; tmp="$(mktemp)"
  grep -vE "^[[:space:]]*(export[[:space:]]+)?$1=" "${APP_ENV_FILE}" > "${tmp}" 2>/dev/null || true
  printf '%s=%s\n' "$1" "$2" >> "${tmp}"
  # cat, bukan mv: menjaga mode 600 dan inode file aslinya.
  cat "${tmp}" > "${APP_ENV_FILE}"
  rm -f "${tmp}"
}

apply_env_overrides() {
  local file="${APP_DIR}/app.env.override"
  [ -f "${file}" ] || return 0

  # Secret tidak boleh tertinggal di disk setelah dipakai — trap EXIT (bukan
  # RETURN) karena run.sh jalan dengan `set -e`: kalau env_set gagal di
  # tengah loop (disk penuh, permission), shell langsung keluar tanpa pernah
  # sampai ke baris sesudah loop. RETURN tidak akan terpicu pada abort
  # semacam itu; hanya EXIT yang terpicu baik pada return normal maupun
  # abort set -e, jadi ini satu-satunya cara file override selalu terhapus
  # sukses maupun gagal.
  trap 'rm -f "${file}"' EXIT

  local applied="" line key value
  while IFS= read -r line || [ -n "${line}" ]; do
    case "${line}" in ''|'#'*) continue ;; esac
    case "${line}" in *=*) ;; *) continue ;; esac

    key="${line%%=*}"
    value="${line#*=}"
    # Nilai TIDAK PERNAH di-eval; hanya dipotong sebagai string.
    case "${key}" in ''|[0-9]*|*[!A-Za-z0-9_]*) continue ;; esac

    env_set "${key}" "${value}"
    applied="${applied}${applied:+, }${key}"
  done < "${file}"

  # Nama key saja — mencetak nilainya akan membocorkan secret ke log deploy.
  [ -n "${applied}" ] && info "app.env: overrode ${applied}"
  trap - EXIT
  rm -f "${file}"
  return 0
}

apply_env_overrides

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
