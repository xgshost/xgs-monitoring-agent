#!/usr/bin/env bash
set -Eeuo pipefail

readonly REPOSITORY_DIR="/opt/xgs-monitoring-agent"
readonly SERVICE_NAME="xgs-monitor-agent"

if [[ ${EUID} -ne 0 ]]; then
  printf 'Run this updater with sudo: sudo %s\n' "$0" >&2
  exit 1
fi

if [[ ! -d "${REPOSITORY_DIR}/.git" ]]; then
  printf 'Agent Git checkout not found: %s\n' "$REPOSITORY_DIR" >&2
  exit 1
fi

branch="$(git -C "$REPOSITORY_DIR" branch --show-current)"
if [[ "$branch" != "main" ]]; then
  printf 'Expected the main branch; found: %s\n' "$branch" >&2
  exit 1
fi

if [[ -n "$(git -C "$REPOSITORY_DIR" status --porcelain)" ]]; then
  printf 'Agent checkout has local changes; refusing to update.\n' >&2
  exit 1
fi

for command in git npm systemctl; do
  if ! command -v "$command" >/dev/null 2>&1; then
    printf 'Required command not found: %s\n' "$command" >&2
    exit 1
  fi
done

git -C "$REPOSITORY_DIR" pull --ff-only origin main

(
  cd "$REPOSITORY_DIR"
  npm ci
  npm run build
  npm test
  npm prune --omit=dev
)

systemctl restart "$SERVICE_NAME"
if ! systemctl is-active --quiet "$SERVICE_NAME"; then
  printf 'Agent service did not become active after restart.\n' >&2
  exit 1
fi

printf 'Updated monitoring agent to %s; service is active.\n' \
  "$(git -C "$REPOSITORY_DIR" rev-parse --short HEAD)"
