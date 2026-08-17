#!/usr/bin/env bash
#
# BUILD HOST (VPS1). Clones the app, builds ONE image containing both the
# runtime and the migration tooling, pushes it, then hands off to run.sh on
# the runtime host.
#
#   ./deploy.sh <repo-url> [branch]     first time (or any time)
#   ./deploy.sh <project>  [branch]     re-deploy something already cloned
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

if [ -n "${REPO_URL}" ]; then
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
if [ -z "${REPO_URL}" ] && [ ! -d "${SRC}/.git" ]; then
  die "Unknown project '${PROJECT}'. Pass the repository URL the first time:
  deploy.sh git@github.com:org/${PROJECT}.git [branch]"
fi

echo ""
echo -e "${BLUE}Deploying ${PROJECT}${RESET}"
echo "Branch: ${BRANCH:-<repository default>}"
echo ""

# ------------------------------------------------------------------
# 2. Source code
# ------------------------------------------------------------------

if [ -d "${SRC}/.git" ]; then
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

success "Source ready (${BRANCH})."

cd "${SRC}"

SHA="$(git rev-parse --short HEAD)"
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
