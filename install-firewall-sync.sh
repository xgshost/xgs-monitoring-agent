#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

readonly INSTALL_DIR="/opt/xgs-monitoring-agent"
readonly ENV_FILE="/etc/xgs-monitor-agent.env"
readonly STATE_FILE="/var/lib/xgs-monitor-agent/credentials.json"
readonly UNIT_DIR="/etc/systemd/system"
readonly SERVICE_NAME="xgs-monitor-agent-firewall-sync.service"
readonly TIMER_NAME="xgs-monitor-agent-firewall-sync.timer"
readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"

fail() {
  printf 'Firewall sync installer error: %s\n' "$1" >&2
  exit 1
}

install_nftables_if_missing() {
  if command -v nft >/dev/null 2>&1; then
    return
  fi
  [[ -r /etc/os-release ]] ||
    fail "Cannot identify the operating system to install nftables"
  . /etc/os-release
  [[ "${ID:-}" == "debian" || "${ID:-}" == "ubuntu" ]] ||
    fail "Automatic nftables installation is supported only on Debian or Ubuntu"
  command -v apt-get >/dev/null 2>&1 ||
    fail "nftables is missing and apt-get is unavailable"

  printf 'The nftables package is required. The installer will not enable nftables.service or change UFW.\n'
  read -r -p "Install nftables using apt-get? [y/N] " answer </dev/tty
  [[ "$answer" =~ ^[Yy]([Ee][Ss])?$ ]] || fail "nftables installation declined"

  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends nftables
  command -v nft >/dev/null 2>&1 ||
    fail "nftables installation completed but the nft command is unavailable"
}

if [[ "${1:-}" == "--help" ]]; then
  cat <<'HELP'
Install the SSH-only nftables policy synchronizer.

Run after the monitoring agent has been built and enrolled:
  sudo ./install-firewall-sync.sh

This installs a systemd timer that polls the central service over HTTPS.
If nft is missing, it offers to install nftables via APT without enabling its
systemd service or changing UFW.
Autobans remain disabled centrally until an administrator enables them.
HELP
  exit 0
fi

[[ "$#" -eq 0 ]] || fail "Unknown option: $1"
[[ "$EUID" -eq 0 ]] || fail "Run with sudo: sudo ./install-firewall-sync.sh"
[[ "$SCRIPT_DIR" == "$INSTALL_DIR" ]] ||
  fail "Run this script from $INSTALL_DIR"
[[ -f "$INSTALL_DIR/dist/firewall-sync.js" ]] ||
  fail "Build the agent before installing the firewall synchronizer"
[[ -f "$ENV_FILE" && -f "$STATE_FILE" ]] ||
  fail "The monitoring agent must be installed and enrolled first"
command -v systemctl >/dev/null || fail "systemd is required"
[[ ! -e "$UNIT_DIR/$SERVICE_NAME" && ! -e "$UNIT_DIR/$TIMER_NAME" ]] ||
  fail "A firewall sync unit already exists; inspect it before replacing it"

printf 'This installs a restricted service and timer with CAP_NET_ADMIN.\n'
printf 'It can only reconcile the dedicated XGS SSH nftables table using\n'
printf 'policy retrieved over authenticated HTTPS; it does not run remote commands.\n'
read -r -p "Install and enable the timer? [y/N] " answer </dev/tty
[[ "$answer" =~ ^[Yy]([Ee][Ss])?$ ]] || fail "Cancelled"

install_nftables_if_missing

install -o root -g root -m 0644 \
  "$SCRIPT_DIR/deploy/systemd/$SERVICE_NAME" "$UNIT_DIR/$SERVICE_NAME"
install -o root -g root -m 0644 \
  "$SCRIPT_DIR/deploy/systemd/$TIMER_NAME" "$UNIT_DIR/$TIMER_NAME"
systemctl daemon-reload
systemctl enable --now "$TIMER_NAME"
printf 'Firewall policy synchronizer timer is enabled. Central autobans remain disabled by default.\n'
