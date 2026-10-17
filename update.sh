#!/usr/bin/env bash
set -Eeuo pipefail

readonly REPOSITORY_DIR="/opt/xgs-monitoring-agent"
readonly SERVICE_NAME="xgs-monitor-agent"
readonly SUCCESS_MARKER="${REPOSITORY_DIR}/.git/xgs-monitor-agent-successful-update"
readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
source "$SCRIPT_DIR/update-sudoers.sh"

print_banner() {
  local component="$1"
  if [[ -t 1 ]]; then
    cat <<'BANNER'
X   X   GGGGG   SSSSS
 X X    G       S
  X     G GGG   SSSSS
 X X    G   G       S
X   X   GGGGG   SSSSS

       XGS MONITORING AGENT
BANNER
    printf '             %s\n' "$component"
  else
    printf 'XGS Monitoring Agent %s\n' "$component"
  fi
}

rebuild_current=false
if [[ "$#" -eq 1 && "$1" == "--rebuild-current" ]]; then
  rebuild_current=true
elif [[ "$#" -ne 0 ]]; then
  printf 'XGS Monitoring Agent updater: usage: sudo %s [--rebuild-current]\n' "$0" >&2
  exit 2
fi

print_banner "updater"

if [[ ${EUID} -ne 0 ]]; then
  printf 'XGS Monitoring Agent updater: run with sudo: sudo %s\n' "$0" >&2
  exit 1
fi

if [[ ! -d "${REPOSITORY_DIR}/.git" ]]; then
  printf 'XGS Monitoring Agent updater: Git checkout not found: %s\n' "$REPOSITORY_DIR" >&2
  exit 1
fi

branch="$(git -C "$REPOSITORY_DIR" branch --show-current)"
if [[ "$branch" != "main" ]]; then
  printf 'XGS Monitoring Agent updater: expected branch main; found %s\n' "$branch" >&2
  exit 1
fi

if [[ -n "$(git -C "$REPOSITORY_DIR" status --porcelain)" ]]; then
  printf 'XGS Monitoring Agent updater: local changes found; refusing to update.\n' >&2
  exit 1
fi

for command in git npm systemctl flock; do
  if ! command -v "$command" >/dev/null 2>&1; then
    printf 'XGS Monitoring Agent updater: required command not found: %s\n' "$command" >&2
    exit 1
  fi
done

exec 9>/run/lock/xgs-monitor-agent-update.lock
if ! flock -n 9; then
  printf 'Update already running; skipped.\n'
  exit 0
fi

ensure_update_sudoers_rule

output_log="$(mktemp "${TMPDIR:-/tmp}/xgs-monitor-agent-update.XXXXXX")"
trap 'rm -f -- "$output_log"' EXIT

run_step() {
  local label="$1"
  shift

  printf '  %s: ' "$label"
  if "$@" >"$output_log" 2>&1; then
    printf 'OK\n'
  else
    local status=$?
    printf 'FAILED\n' >&2
    cat "$output_log" >&2
    return "$status"
  fi
}

run_step "Checking for updates" git -C "$REPOSITORY_DIR" fetch origin main
current_commit="$(git -C "$REPOSITORY_DIR" rev-parse HEAD)"
available_commit="$(git -C "$REPOSITORY_DIR" rev-parse FETCH_HEAD)"
successful_commit=""
if [[ -f "$SUCCESS_MARKER" ]]; then
  successful_commit="$(<"$SUCCESS_MARKER")"
fi
if [[ "$current_commit" == "$available_commit" &&
  "$successful_commit" == "$current_commit" &&
  "$rebuild_current" != true ]]; then
  printf 'Already up to date (%s).\n' "${current_commit:0:7}"
  exit 0
fi

if ! git -C "$REPOSITORY_DIR" merge-base --is-ancestor \
  "$current_commit" "$available_commit"; then
  printf 'XGS Monitoring Agent updater: remote main is not a fast-forward; refusing to update.\n' >&2
  exit 1
fi

run_step "Applying update" git -C "$REPOSITORY_DIR" merge --ff-only "$available_commit"

(
  cd "$REPOSITORY_DIR"
  run_step "Installing dependencies" npm ci
  run_step "Building agent" npm run build
  run_step "Running tests" npm test
  run_step "Preparing production files" npm prune --omit=dev
)

run_step "Restarting service" systemctl restart "$SERVICE_NAME"
if ! systemctl is-active --quiet "$SERVICE_NAME"; then
  printf 'XGS Monitoring Agent updater: service did not become active after restart.\n' >&2
  exit 1
fi

marker_temp="${SUCCESS_MARKER}.tmp"
printf '%s\n' "$available_commit" >"$marker_temp"
chmod 0600 "$marker_temp"
mv -f "$marker_temp" "$SUCCESS_MARKER"

printf 'Update complete: %s; agent service is active.\n' \
  "$(git -C "$REPOSITORY_DIR" rev-parse --short HEAD)"
