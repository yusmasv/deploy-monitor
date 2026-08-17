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
