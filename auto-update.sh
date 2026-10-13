#!/usr/bin/env bash
set -Eeuo pipefail

readonly REPOSITORY_DIR="/opt/xgs-monitoring-agent"
readonly SYSTEMD_DIR="/etc/systemd/system"
readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly SERVICE_UNIT="xgs-monitor-agent-update.service"
readonly TIMER_UNIT="xgs-monitor-agent-update.timer"

fail() {
  printf 'Auto-update setup error: %s\n' "$1" >&2
  exit 1
}

usage() {
  cat <<'HELP'
Enable, disable, or inspect the optional daily agent update timer.

Usage:
  sudo ./auto-update.sh enable
  sudo ./auto-update.sh disable
  sudo ./auto-update.sh status
HELP
}

if [[ ${EUID} -ne 0 ]]; then
  fail "Run with sudo: sudo ./auto-update.sh <enable|disable|status>"
fi

[[ "$SCRIPT_DIR" == "$REPOSITORY_DIR" ]] ||
  fail "Run this command from $REPOSITORY_DIR"
[[ -d "$REPOSITORY_DIR/.git" ]] ||
  fail "Agent Git checkout not found: $REPOSITORY_DIR"

action="${1:-}"
[[ "$#" -eq 1 ]] || {
  usage >&2
  exit 2
}

case "$action" in
  enable)
    for unit in "$SERVICE_UNIT" "$TIMER_UNIT"; do
      source_file="$REPOSITORY_DIR/deploy/systemd/$unit"
      destination="$SYSTEMD_DIR/$unit"
      [[ -f "$source_file" ]] || fail "Missing unit file: $source_file"
      if [[ -e "$destination" ]] && ! cmp -s "$source_file" "$destination"; then
        fail "$destination already exists and differs; inspect it before replacing"
      fi
      install -o root -g root -m 0644 "$source_file" "$destination"
    done
    systemctl daemon-reload
    systemctl enable --now "$TIMER_UNIT"
    systemctl is-active --quiet "$TIMER_UNIT" ||
      fail "The update timer did not become active"
    printf 'Daily agent auto-update timer enabled.\n'
    ;;
  disable)
    if [[ ! -e "$SYSTEMD_DIR/$TIMER_UNIT" ]]; then
      printf 'Agent auto-update timer is not installed; it is already disabled.\n'
      exit 0
    fi
    if systemctl is-enabled --quiet "$TIMER_UNIT"; then
      systemctl disable --now "$TIMER_UNIT"
    else
      systemctl stop "$TIMER_UNIT"
    fi
    printf 'Agent auto-update timer disabled.\n'
    ;;
  status)
    if [[ ! -e "$SYSTEMD_DIR/$TIMER_UNIT" ]]; then
      printf 'Agent auto-update timer is not installed; it is disabled.\n'
      exit 0
    fi
    if systemctl is-enabled --quiet "$TIMER_UNIT"; then
      printf 'Agent auto-update timer is enabled.\n'
    else
      printf 'Agent auto-update timer is disabled.\n'
    fi
    systemctl list-timers --all --no-pager "$TIMER_UNIT"
    ;;
  --help|-h)
    usage
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac
