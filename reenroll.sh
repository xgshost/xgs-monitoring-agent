#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

readonly INSTALL_DIR="/opt/xgs-monitoring-agent"
readonly SERVICE_USER="xgs-monitor-agent"
readonly SERVICE_NAME="xgs-monitor-agent.service"
readonly ENV_FILE="/etc/xgs-monitor-agent.env"
readonly UNIT_FILE="/etc/systemd/system/xgs-monitor-agent.service"
readonly STATE_DIR="/var/lib/xgs-monitor-agent"
readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"

temporary_env_file=""
enrollment_token=""

fail() {
  printf 'Re-enrollment error: %s\n' "$1" >&2
  exit 1
}

cleanup() {
  if [[ -n "$temporary_env_file" && -e "$temporary_env_file" ]]; then
    rm -f -- "$temporary_env_file"
  fi
  unset enrollment_token
}
trap cleanup EXIT

confirm() {
  local answer
  read -r -p "$1 [y/N] " answer </dev/tty
  [[ "$answer" =~ ^[Yy]([Ee][Ss])?$ ]]
}

if [[ "${1:-}" == "--help" ]]; then
  cat <<'HELP'
Re-enroll an existing XGS Monitoring Agent.

Run from /opt/xgs-monitoring-agent:
  sudo ./reenroll.sh

The script reuses the configured monitoring URL, prompts for a one-use token
without echoing it, preserves the existing agent state file, and restarts the
agent service after enrollment.
HELP
  exit 0
fi

[[ "$#" -eq 0 ]] || fail "Usage: sudo ./reenroll.sh"
[[ "$EUID" -eq 0 ]] || fail "Run with sudo: sudo ./reenroll.sh"
[[ "$SCRIPT_DIR" == "$INSTALL_DIR" ]] ||
  fail "Run this script from $INSTALL_DIR"
[[ -f "$ENV_FILE" && ! -L "$ENV_FILE" ]] ||
  fail "The agent environment file is missing or is a symbolic link"
[[ -f "$UNIT_FILE" ]] || fail "The agent systemd unit is missing"
[[ -d "$STATE_DIR" ]] || fail "The agent state directory is missing"
getent passwd "$SERVICE_USER" >/dev/null ||
  fail "The $SERVICE_USER account is missing"

for command in date getent mktemp node systemctl; do
  command -v "$command" >/dev/null ||
    fail "Required command not found: $command"
done

unit_load_state="$(systemctl show --property=LoadState --value "$SERVICE_NAME")"
[[ "$unit_load_state" != "not-found" ]] ||
  fail "The agent systemd unit is not loaded"

monitor_url=""
url_count=0
while IFS= read -r line || [[ -n "$line" ]]; do
  case "$line" in
    XGS_MONITOR_URL=*)
      url_count=$((url_count + 1))
      monitor_url="${line#XGS_MONITOR_URL=}"
      ;;
  esac
done <"$ENV_FILE"

[[ "$url_count" -eq 1 && -n "$monitor_url" ]] ||
  fail "Exactly one XGS_MONITOR_URL setting is required"
[[ "$monitor_url" =~ ^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?(/[A-Za-z0-9._~/-]*)?$ ]] ||
  fail "The configured monitoring URL is invalid"

printf 'A new state file will be used; the existing state file will be preserved.\n'
confirm "Continue with agent re-enrollment?" || fail "Cancelled"

if ! read -r -s -p "One-use enrollment token (input hidden): " enrollment_token </dev/tty; then
  fail "Could not read the enrollment token from the terminal"
fi
printf '\n'
[[ "$enrollment_token" =~ ^[A-Za-z0-9_-]{43}$ ]] ||
  fail "The enrollment token format is invalid"

state_file="${STATE_DIR}/credentials.reenroll-$(date +%s%N).json"
[[ ! -e "$state_file" ]] || fail "A re-enrollment state file already exists"

write_pending_config() {
  local token_written=false
  local state_written=false
  temporary_env_file="$(mktemp /etc/.xgs-monitor-agent.env.XXXXXX)"

  while IFS= read -r line || [[ -n "$line" ]]; do
    case "$line" in
      XGS_MONITOR_ENROLLMENT_TOKEN=*)
        if [[ "$token_written" == false ]]; then
          printf 'XGS_MONITOR_ENROLLMENT_TOKEN=%s\n' "$enrollment_token" \
            >>"$temporary_env_file"
          token_written=true
        fi
        ;;
      XGS_MONITOR_AGENT_STATE_FILE=*)
        if [[ "$state_written" == false ]]; then
          printf 'XGS_MONITOR_AGENT_STATE_FILE=%s\n' "$state_file" \
            >>"$temporary_env_file"
          state_written=true
        fi
        ;;
      *)
        printf '%s\n' "$line" >>"$temporary_env_file"
        ;;
    esac
  done <"$ENV_FILE"

  if [[ "$token_written" == false ]]; then
    printf 'XGS_MONITOR_ENROLLMENT_TOKEN=%s\n' "$enrollment_token" \
      >>"$temporary_env_file"
  fi
  if [[ "$state_written" == false ]]; then
    printf 'XGS_MONITOR_AGENT_STATE_FILE=%s\n' "$state_file" \
      >>"$temporary_env_file"
  fi

  chown root:root "$temporary_env_file"
  chmod 0600 "$temporary_env_file"
  mv -f -- "$temporary_env_file" "$ENV_FILE"
  temporary_env_file=""
}

remove_enrollment_token() {
  local token_removed=false
  temporary_env_file="$(mktemp /etc/.xgs-monitor-agent.env.XXXXXX)"

  while IFS= read -r line || [[ -n "$line" ]]; do
    case "$line" in
      XGS_MONITOR_ENROLLMENT_TOKEN=*)
        token_removed=true
        ;;
      *)
        printf '%s\n' "$line" >>"$temporary_env_file"
        ;;
    esac
  done <"$ENV_FILE"

  [[ "$token_removed" == true ]] ||
    fail "The staged enrollment token setting is missing"
  chown root:root "$temporary_env_file"
  chmod 0600 "$temporary_env_file"
  mv -f -- "$temporary_env_file" "$ENV_FILE"
  temporary_env_file=""
}

state_is_enrolled() {
  node -e '
    const fs = require("node:fs");
    try {
      const state = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      process.exit(state.enrollmentAccepted === true ? 0 : 1);
    } catch {
      process.exit(1);
    }
  ' "$state_file" >/dev/null 2>&1
}

write_pending_config
unset enrollment_token
systemctl restart "$SERVICE_NAME"

printf 'Waiting for enrollment to complete (up to 90 seconds)...\n'
enrolled=false
for ((attempt = 0; attempt < 45; attempt++)); do
  if state_is_enrolled; then
    enrolled=true
    break
  fi
  sleep 2
done

[[ "$enrolled" == true ]] ||
  fail "Enrollment was not confirmed; the protected token remains for agent retry"

remove_enrollment_token
systemctl restart "$SERVICE_NAME"
systemctl is-active --quiet "$SERVICE_NAME" ||
  fail "Enrollment succeeded but the agent service is not active"
state_is_enrolled ||
  fail "Enrollment succeeded but the new agent state was not retained"

printf 'Re-enrollment succeeded; the agent is active and the one-use token was removed.\n'
