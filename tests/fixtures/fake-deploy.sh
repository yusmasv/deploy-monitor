#!/usr/bin/env bash
# deploy.sh palsu: mencetak penanda fase yang sama dengan yang asli, berwarna,
# lalu keluar dengan FAKE_EXIT. Membuat test runner tidak butuh docker/VPS.
set -u
CYAN='\033[0;36m'; GREEN='\033[0;32m'; MAGENTA='\033[0;35m'; RESET='\033[0m'

echo -e "${CYAN}Cloning repository...${RESET}"
echo -e "${CYAN}Detecting configuration...${RESET}"
echo "Commit: deadbee"
echo -e "${MAGENTA}Building image...${RESET}"
echo "Step 1/5 : FROM node:22-alpine"
[ -n "${ENV_OVERRIDES_FILE:-}" ] && echo "OVERRIDES_SEEN=${ENV_OVERRIDES_FILE}"
echo -e "${MAGENTA}Pushing image...${RESET}"
echo -e "${MAGENTA}Triggering runtime deployment...${RESET}"
echo -e "${MAGENTA}Starting application...${RESET}"
echo "gagal-di-stderr" >&2
echo "Image  : 10.8.0.2:5000/app:deadbee"
echo "Port    : 3000"
echo -e "${GREEN}Deployment completed.${RESET}"
exit "${FAKE_EXIT:-0}"
