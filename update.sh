#!/usr/bin/env bash
set -Eeuo pipefail

readonly REPOSITORY_DIR="/opt/xgs-monitoring-agent"
readonly SERVICE_NAME="xgs-monitor-agent"
readonly SUCCESS_MARKER="${REPOSITORY_DIR}/.git/xgs-monitor-agent-successful-update"
readonly BAN_SYNC_TIMER="xgs-monitor-agent-firewall-sync.timer"
readonly BAN_SYNC_DISABLED_MARKER="/etc/xgs-monitor-agent-ban-sync.disabled"
readonly BAN_JAIL_CONFIG="/etc/fail2ban/jail.d/xgs-monitor-agent.conf"
readonly DEFAULT_SSH_JAIL_OVERRIDE="/etc/fail2ban/jail.d/xgs-monitor-agent.local"
readonly V2_MIGRATION_MARKER="/etc/xgs-monitor-agent-v2.migrated"
readonly V2_MIGRATION_SCRIPT="${REPOSITORY_DIR}/deploy/migrate-agent-v1-to-v2-host.sh"
readonly V2_AGENT_DIST_DIR="${REPOSITORY_DIR}/deploy/v2-agent-dist"
readonly V2_RELEASE_VERSION="2.0.0"
readonly UPDATE_LOCK_FILE="/run/lock/xgs-monitor-agent-update.lock"
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
disable_ban_sync=false
upgrade_to_v2=true
if [[ "$#" -eq 1 && "$1" == "--disable-ban-sync" ]]; then
  disable_ban_sync=true
elif [[ "$#" -eq 1 && "$1" == "--rebuild-current" ]]; then
  rebuild_current=true
elif [[ "$#" -eq 1 && "$1" == "--upgrade-to-v2" ]]; then
  upgrade_to_v2=true
elif [[ "$#" -ne 0 ]]; then
  printf 'XGS Monitoring Agent updater: usage: sudo %s [--rebuild-current | --disable-ban-sync | --upgrade-to-v2]\n' "$0" >&2
  exit 2
fi

print_banner "updater"

if [[ ${EUID} -ne 0 ]]; then
  printf 'XGS Monitoring Agent updater: run with sudo: sudo %s\n' "$0" >&2
  exit 1
fi

if [[ -f "$V2_MIGRATION_MARKER" ]]; then
  printf 'V2 migration is complete; V2 HTTPS releases now manage agent updates.\n'
  exit 0
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

for command in git npm systemctl systemd-run flock; do
  if ! command -v "$command" >/dev/null 2>&1; then
    printf 'XGS Monitoring Agent updater: required command not found: %s\n' "$command" >&2
    exit 1
  fi
done

if [[ "${XGS_MONITOR_AGENT_UPDATE_LOCK_HELD:-}" == "1" ]]; then
  lock_target="$(readlink -f /proc/self/fd/9 2>/dev/null || true)"
  if [[ "$lock_target" != "$UPDATE_LOCK_FILE" ]] || ! flock -n 9; then
    printf 'XGS Monitoring Agent updater: inherited update lock is unavailable.\n' >&2
    exit 1
  fi
else
  exec 9>"$UPDATE_LOCK_FILE"
  if ! flock -n 9; then
    printf 'Update already running; skipped.\n'
    exit 0
  fi
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

update_ban_sync_if_ufw_active() {
  if [[ -e "$BAN_SYNC_DISABLED_MARKER" ]]; then
    run_step "Keeping host SSH autoban sync disabled" \
      "$REPOSITORY_DIR/install-ban-sync.sh" --remove
    return 0
  fi

  if ! command -v ufw >/dev/null 2>&1; then
    printf 'Warning: UFW is not installed; Fail2ban SSH setup was skipped during update.\n' >&2
    return 0
  fi

  local ufw_status
  if ! ufw_status="$(ufw status 2>&1)"; then
    printf 'Warning: could not check UFW status; Fail2ban SSH setup was skipped during update.\n' >&2
    return 0
  fi
  if ! grep -qx 'Status: active' <<<"$ufw_status"; then
    printf 'Warning: UFW is not active; Fail2ban SSH setup was skipped during update.\n' >&2
    return 0
  fi

  local jail_source="$REPOSITORY_DIR/deploy/fail2ban/jail.d/xgs-monitor-agent.conf"
  local sshd_override_source="$REPOSITORY_DIR/deploy/fail2ban/jail.d/xgs-monitor-agent.local"
  if [[ -f "$BAN_JAIL_CONFIG" && -f "$DEFAULT_SSH_JAIL_OVERRIDE" ]] &&
    cmp -s "$jail_source" "$BAN_JAIL_CONFIG" &&
    cmp -s "$sshd_override_source" "$DEFAULT_SSH_JAIL_OVERRIDE" &&
    systemctl is-active --quiet fail2ban.service &&
    systemctl is-active --quiet "$BAN_SYNC_TIMER"; then
    printf 'Fail2ban SSH jail and policy sync are current.\n'
    return 0
  fi

  run_step "Updating Fail2ban SSH policy" \
    "$REPOSITORY_DIR/install-ban-sync.sh" --yes
}

if [[ "$disable_ban_sync" == true ]]; then
  run_step "Disabling host SSH autoban synchronization" \
    "$REPOSITORY_DIR/install-ban-sync.sh" --remove
  printf 'Host SSH autoban synchronization is disabled; the Monitoring agent remains active.\n'
  exit 0
fi

run_step "Checking for updates" git -C "$REPOSITORY_DIR" fetch origin main
current_commit="$(git -C "$REPOSITORY_DIR" rev-parse HEAD)"
available_commit="$(git -C "$REPOSITORY_DIR" rev-parse FETCH_HEAD)"
successful_commit=""
if [[ -f "$SUCCESS_MARKER" ]]; then
  successful_commit="$(<"$SUCCESS_MARKER")"
fi
if [[ "$current_commit" == "$available_commit" &&
  "$successful_commit" == "$current_commit" &&
  "$rebuild_current" != true &&
  "$upgrade_to_v2" != true ]]; then
  update_ban_sync_if_ufw_active
  printf 'Already up to date (%s).\n' "${current_commit:0:7}"
  exit 0
fi

if ! git -C "$REPOSITORY_DIR" merge-base --is-ancestor \
  "$current_commit" "$available_commit"; then
  printf 'XGS Monitoring Agent updater: remote main is not a fast-forward; refusing to update.\n' >&2
  exit 1
fi

run_step "Applying update" git -C "$REPOSITORY_DIR" merge --ff-only "$available_commit"

if [[ "$current_commit" != "$available_commit" ]]; then
  printf 'Updater refreshed to %s; continuing with the new version.\n' \
    "${available_commit:0:7}"
  update_args=()
  [[ "$rebuild_current" == true ]] && update_args+=(--rebuild-current)
  [[ "$upgrade_to_v2" == true ]] && update_args+=(--upgrade-to-v2)
  XGS_MONITOR_AGENT_UPDATE_LOCK_HELD=1 \
    "$REPOSITORY_DIR/update.sh" "${update_args[@]}" || exit $?
  exit 0
fi

if [[ "$upgrade_to_v2" == true ]]; then
  if [[ ! -f "$V2_MIGRATION_SCRIPT" ]]; then
    printf 'XGS Monitoring Agent updater: V2 migration script not found: %s\n' \
      "$V2_MIGRATION_SCRIPT" >&2
    exit 1
  fi
  if [[ ! -s "$V2_AGENT_DIST_DIR/index.js" ]]; then
    printf 'XGS Monitoring Agent updater: V2 agent bundle not found: %s\n' \
      "$V2_AGENT_DIST_DIR" >&2
    exit 1
  fi
  server_name="$(hostname -f)" ||
    { printf 'XGS Monitoring Agent updater: could not determine the system FQDN.\n' >&2; exit 1; }
  run_step "Migrating V1 agent to V2" systemd-run \
    --quiet \
    --wait \
    --collect \
    --pipe \
    --unit=xgs-monitor-agent-v2-migration \
    --property=Type=oneshot \
    --property=User=root \
    --property=Group=root \
    --property=ProtectSystem=true \
    --property=ProtectHome=true \
    --property=PrivateTmp=true \
    --property=ProtectKernelTunables=true \
    --property=ProtectControlGroups=true \
    --property=LockPersonality=true \
    /usr/bin/env XGS_MONITOR_AGENT_UPDATE_LOCK_HELD=1 \
    /bin/bash "$V2_MIGRATION_SCRIPT" install \
    --agent-dist-dir "$V2_AGENT_DIST_DIR" \
    --server-name "$server_name" \
    --release-version "$V2_RELEASE_VERSION" \
    --remove-v1-after-install
  if enrollment_line="$(grep -m1 '^XGS Monitoring enrollment request ' "$output_log")"; then
    printf '%s\n' "$enrollment_line"
  fi
  printf 'V2 migration complete. Approve the enrollment in Discord if it is still pending.\n'
  exit 0
fi

(
  cd "$REPOSITORY_DIR"
  run_step "Installing dependencies" npm ci
  run_step "Building agent" npm run build
  run_step "Running tests" npm test
  run_step "Preparing production files" npm prune --omit=dev
)

update_ban_sync_if_ufw_active

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
