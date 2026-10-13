#!/usr/bin/env bash
set -Eeuo pipefail

readonly REPOSITORY_DIR="/opt/xgs-monitoring-agent"
readonly SERVICE_NAME="xgs-monitor-agent"
readonly SUCCESS_MARKER="${REPOSITORY_DIR}/.git/xgs-monitor-agent-successful-update"

rebuild_current=false
if [[ "$#" -eq 1 && "$1" == "--rebuild-current" ]]; then
  rebuild_current=true
elif [[ "$#" -ne 0 ]]; then
  printf 'Usage: sudo %s [--rebuild-current]\n' "$0" >&2
  exit 2
fi

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

for command in git npm systemctl flock; do
  if ! command -v "$command" >/dev/null 2>&1; then
    printf 'Required command not found: %s\n' "$command" >&2
    exit 1
  fi
done

exec 9>/run/lock/xgs-monitor-agent-update.lock
if ! flock -n 9; then
  printf 'Another monitoring agent update is already running; skipping.\n'
  exit 0
fi

git -C "$REPOSITORY_DIR" fetch origin main
current_commit="$(git -C "$REPOSITORY_DIR" rev-parse HEAD)"
available_commit="$(git -C "$REPOSITORY_DIR" rev-parse FETCH_HEAD)"
successful_commit=""
if [[ -f "$SUCCESS_MARKER" ]]; then
  successful_commit="$(<"$SUCCESS_MARKER")"
fi
if [[ "$current_commit" == "$available_commit" &&
  "$successful_commit" == "$current_commit" &&
  "$rebuild_current" != true ]]; then
  printf 'Monitoring agent is already up to date (%s).\n' "$current_commit"
  exit 0
fi

if ! git -C "$REPOSITORY_DIR" merge-base --is-ancestor \
  "$current_commit" "$available_commit"; then
  printf 'Remote main is not a fast-forward of the installed version; refusing to update.\n' >&2
  exit 1
fi

git -C "$REPOSITORY_DIR" merge --ff-only "$available_commit"

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

marker_temp="${SUCCESS_MARKER}.tmp"
printf '%s\n' "$available_commit" >"$marker_temp"
chmod 0600 "$marker_temp"
mv -f "$marker_temp" "$SUCCESS_MARKER"

printf 'Updated monitoring agent to %s; service is active.\n' \
  "$(git -C "$REPOSITORY_DIR" rev-parse --short HEAD)"
