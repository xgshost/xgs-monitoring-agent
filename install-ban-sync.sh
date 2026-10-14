#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

readonly INSTALL_DIR="/opt/xgs-monitoring-agent"
readonly ENV_FILE="/etc/xgs-monitor-agent.env"
readonly STATE_FILE="/var/lib/xgs-monitor-agent/credentials.json"
readonly UNIT_DIR="/etc/systemd/system"
readonly SERVICE_NAME="xgs-monitor-agent-firewall-sync.service"
readonly TIMER_NAME="xgs-monitor-agent-firewall-sync.timer"
readonly FAIL2BAN_GROUP="xgs-monitor-agent-fail2ban"
readonly UFW_PROFILE="XGSMonitorAgentSSH"
readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"

fail() {
  printf 'Ban sync installer error: %s\n' "$1" >&2
  exit 1
}

confirm() {
  local answer
  read -r -p "$1 [y/N] " answer </dev/tty
  [[ "$answer" =~ ^[Yy]([Ee][Ss])?$ ]]
}

managed_or_missing() {
  local file="$1"
  if [[ -e "$file" ]] &&
    ! grep -Fqx '# Managed by XGS Monitoring Agent.' "$file"; then
    fail "$file exists and is not marked as managed by this installer"
  fi
}

configured_ssh_ports() {
  local value
  local -a entries
  value="$(awk -F= '$1 == "XGS_MONITOR_SSH_PORTS" {
    sub(/^[^=]*=/, "")
    print
  }' "$ENV_FILE")"
  [[ -n "$value" ]] || value="22"
  [[ "$value" =~ ^[0-9]+(,[0-9]+){0,31}$ ]] ||
    fail "XGS_MONITOR_SSH_PORTS must be up to 32 comma-separated numeric ports"

  IFS=, read -r -a entries <<<"$value"
  local -A seen=()
  local port
  for port in "${entries[@]}"; do
    [[ "$port" =~ ^[0-9]{1,5}$ ]] ||
      fail "XGS_MONITOR_SSH_PORTS contains a non-numeric port"
    ((10#$port >= 1 && 10#$port <= 65535)) ||
      fail "XGS_MONITOR_SSH_PORTS contains a port outside 1-65535"
    [[ -z "${seen[$((10#$port))]:-}" ]] ||
      fail "XGS_MONITOR_SSH_PORTS contains a duplicate port"
    seen[$((10#$port))]=1
  done

  printf '%s\n' "${!seen[@]}" | sort -n | paste -sd, -
}

install_fail2ban_if_missing() {
  if command -v fail2ban-client >/dev/null 2>&1; then
    return
  fi
  [[ -r /etc/os-release ]] ||
    fail "Cannot identify the operating system to install Fail2ban"
  # shellcheck disable=SC1091
  . /etc/os-release
  [[ "${ID:-}" == "debian" || "${ID:-}" == "ubuntu" ]] ||
    fail "Automatic Fail2ban installation is supported only on Debian or Ubuntu"
  command -v apt-get >/dev/null 2>&1 ||
    fail "Fail2ban is missing and apt-get is unavailable"

  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends fail2ban
  command -v fail2ban-client >/dev/null 2>&1 ||
    fail "Fail2ban installation completed but fail2ban-client is unavailable"
}

if [[ "${1:-}" == "--help" ]]; then
  cat <<'HELP'
Install or migrate XGS SSH autoban enforcement to Fail2ban with UFW.

Run after the monitoring agent has been built and enrolled:
  sudo ./install-ban-sync.sh

This installs Fail2ban if needed, configures a dedicated jail and UFW SSH
application profile, and replaces the prior nftables policy synchronizer.
The legacy XGS nftables table is removed only after the Fail2ban policy sync
succeeds. Central Discord autoban thresholds and allowlists remain unchanged.
HELP
  exit 0
fi

[[ "$#" -eq 0 ]] || fail "Unknown option: $1"
[[ "$EUID" -eq 0 ]] || fail "Run with sudo: sudo ./install-ban-sync.sh"
[[ "$SCRIPT_DIR" == "$INSTALL_DIR" ]] ||
  fail "Run this script from $INSTALL_DIR"
[[ -f "$INSTALL_DIR/dist/firewall-sync.js" ]] ||
  fail "Build the agent before installing the ban synchronizer"
[[ -f "$ENV_FILE" && -f "$STATE_FILE" ]] ||
  fail "The monitoring agent must be installed and enrolled first"
getent passwd xgs-monitor-agent >/dev/null ||
  fail "The xgs-monitor-agent service account is missing"
command -v systemctl >/dev/null || fail "systemd is required"
command -v ufw >/dev/null || fail "UFW is required and will not be installed or enabled"
grep -q '^Status: active$' < <(ufw status) ||
  fail "UFW is not active; enable and verify UFW before installing this synchronizer"

if [[ -e "$UNIT_DIR/$SERVICE_NAME" ]] &&
  ! grep -Fqx 'ExecStart=/usr/bin/node /opt/xgs-monitoring-agent/dist/firewall-sync.js' \
    "$UNIT_DIR/$SERVICE_NAME"; then
  managed_or_missing "$UNIT_DIR/$SERVICE_NAME"
fi
if [[ -e "$UNIT_DIR/$TIMER_NAME" ]] &&
  ! grep -Fqx "Unit=$SERVICE_NAME" "$UNIT_DIR/$TIMER_NAME"; then
  managed_or_missing "$UNIT_DIR/$TIMER_NAME"
fi

readonly FAIL2BAN_DROPIN="$UNIT_DIR/fail2ban.service.d/xgs-monitor-agent.conf"
readonly JAIL_FILE="/etc/fail2ban/jail.d/xgs-monitor-agent.conf"
readonly PROFILE_FILE="/etc/ufw/applications.d/xgs-monitor-agent"
managed_or_missing "$FAIL2BAN_DROPIN"
managed_or_missing "$JAIL_FILE"
managed_or_missing "$PROFILE_FILE"

ports="$(configured_ssh_ports)"
printf 'This will install/configure Fail2ban and a UFW application profile for TCP ports %s.\n' "$ports"
printf 'It will replace the XGS sync service, add the agent account to the Fail2ban control socket group,\n'
printf 'and remove only the legacy inet xgs_monitor_agent table after a successful central-policy sync.\n'
printf 'It will not enable UFW or change its default policy.\n'
confirm "Migrate SSH autoban enforcement to Fail2ban via UFW?" ||
  fail "Cancelled without changing the host"

install_fail2ban_if_missing
command -v groupadd >/dev/null || fail "groupadd is required"
getent group "$FAIL2BAN_GROUP" >/dev/null ||
  groupadd --system "$FAIL2BAN_GROUP"

install -d -o root -g root -m 0755 \
  /etc/fail2ban/jail.d \
  "$UNIT_DIR/fail2ban.service.d" \
  /etc/ufw/applications.d
install -o root -g root -m 0644 \
  "$SCRIPT_DIR/deploy/fail2ban/jail.d/xgs-monitor-agent.conf" "$JAIL_FILE"

profile_tmp="$(mktemp)"
trap 'rm -f "$profile_tmp"' EXIT
{
  printf '%s\n' '# Managed by XGS Monitoring Agent.'
  printf '[%s]\n' "$UFW_PROFILE"
  printf '%s\n' 'title=XGS Monitoring Agent SSH'
  printf '%s\n' 'description=SSH ports protected by XGS Monitoring Agent autobans'
  printf 'ports=%s/tcp\n' "$ports"
} >"$profile_tmp"
install -o root -g root -m 0644 "$profile_tmp" "$PROFILE_FILE"
rm -f "$profile_tmp"
trap - EXIT

cat >"$FAIL2BAN_DROPIN" <<EOF
# Managed by XGS Monitoring Agent.
[Service]
Group=$FAIL2BAN_GROUP
UMask=0117
ExecStartPost=/usr/bin/timeout 10 /bin/sh -c 'while [ ! -S /run/fail2ban/fail2ban.sock ]; do sleep 0.1; done; exec /usr/bin/chmod 0660 /run/fail2ban/fail2ban.sock'
EOF
chmod 0644 "$FAIL2BAN_DROPIN"
chown root:root "$FAIL2BAN_DROPIN"

install -o root -g root -m 0644 \
  "$SCRIPT_DIR/deploy/systemd/$SERVICE_NAME" "$UNIT_DIR/$SERVICE_NAME"
install -o root -g root -m 0644 \
  "$SCRIPT_DIR/deploy/systemd/$TIMER_NAME" "$UNIT_DIR/$TIMER_NAME"

fail2ban-client -t
ufw app info "$UFW_PROFILE" >/dev/null ||
  fail "UFW could not load the generated SSH application profile"
systemctl daemon-reload
systemctl enable --now fail2ban.service
systemctl restart fail2ban.service
systemctl is-active --quiet fail2ban.service ||
  fail "Fail2ban did not become active"

systemctl start "$SERVICE_NAME" ||
  fail "Fail2ban did not apply the central policy; the legacy nftables table was left untouched"
systemctl enable --now "$TIMER_NAME"

if command -v nft >/dev/null 2>&1 &&
  nft list table inet xgs_monitor_agent >/dev/null 2>&1; then
  nft delete table inet xgs_monitor_agent
fi

printf 'Fail2ban/UFW enforcement is active and the central policy synchronizer is enabled.\n'
