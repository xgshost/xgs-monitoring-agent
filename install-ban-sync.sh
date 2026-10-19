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
readonly DISABLED_MARKER="/etc/xgs-monitor-agent-ban-sync.disabled"
readonly FAIL2BAN_DROPIN="$UNIT_DIR/fail2ban.service.d/xgs-monitor-agent.conf"
readonly JAIL_FILE="/etc/fail2ban/jail.d/xgs-monitor-agent.conf"
readonly SSHD_OVERRIDE_FILE="/etc/fail2ban/jail.d/xgs-monitor-agent.local"
readonly PROFILE_FILE="/etc/ufw/applications.d/xgs-monitor-agent"
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
  [[ ! -L "$file" ]] || fail "$file is a symlink; refusing to manage it"
  if [[ -e "$file" ]] &&
    ! grep -Fqx '# Managed by XGS Monitoring Agent.' "$file"; then
    fail "$file exists and is not marked as managed by this installer"
  fi
}

remove_ban_sync() {
  local backup_dir backup_path file status jail_list jail_status banned_text remaining_text
  local marker_tmp nft_tables
  local -a banned_ips=()
  local artifacts=false
  local nft_table_present=false

  for file in \
    "$DISABLED_MARKER" \
    "$UNIT_DIR/$SERVICE_NAME" \
    "$UNIT_DIR/$TIMER_NAME" \
    "$FAIL2BAN_DROPIN" \
    "$JAIL_FILE" \
    "$SSHD_OVERRIDE_FILE" \
    "$PROFILE_FILE"; do
    managed_or_missing "$file"
  done

  for file in \
    "$UNIT_DIR/$SERVICE_NAME" \
    "$UNIT_DIR/$TIMER_NAME" \
    "$FAIL2BAN_DROPIN" \
    "$JAIL_FILE" \
    "$PROFILE_FILE"; do
    [[ ! -e "$file" ]] || artifacts=true
  done

  if command -v nft >/dev/null 2>&1; then
    nft_tables="$(nft list tables)" ||
      fail "Could not inspect nftables before removing the XGS policy"
    if grep -Fxq 'table inet xgs_monitor_agent' <<<"$nft_tables"; then
      nft_table_present=true
      artifacts=true
    fi
  fi

  if [[ -e "$DISABLED_MARKER" && "$artifacts" != true ]]; then
    printf 'Host SSH autoban synchronization is already disabled and removed.\n'
    return 0
  fi

  install -d -o root -g root -m 0700 /var/backups
  backup_dir="$(mktemp -d /var/backups/xgs-monitor-agent-ban-sync.XXXXXX)" ||
    fail "Could not create a protected backup directory"
  chmod 0700 "$backup_dir"
  for file in \
    "$UNIT_DIR/$SERVICE_NAME" \
    "$UNIT_DIR/$TIMER_NAME" \
    "$FAIL2BAN_DROPIN" \
    "$JAIL_FILE" \
    "$SSHD_OVERRIDE_FILE" \
    "$PROFILE_FILE" \
    /etc/ufw/user.rules \
    /etc/ufw/user6.rules; do
    if [[ -e "$file" ]]; then
      backup_path="$backup_dir/${file#/}"
      install -d -o root -g root -m 0700 "${backup_path%/*}"
      cp -a -- "$file" "$backup_path"
    fi
  done

  if command -v ufw >/dev/null 2>&1; then
    ufw status numbered >"$backup_dir/ufw-status.txt" 2>&1 ||
      fail "Could not back up the current UFW rules"
  fi
  if command -v fail2ban-client >/dev/null 2>&1 &&
    systemctl is-active --quiet fail2ban.service; then
    fail2ban-client status >"$backup_dir/fail2ban-status.txt" 2>&1 ||
      fail "Could not back up the active Fail2ban status"
  fi
  if [[ "$nft_table_present" == true ]]; then
    nft list table inet xgs_monitor_agent >"$backup_dir/xgs_monitor_agent.nft" ||
      fail "Could not back up the legacy XGS nftables table"
  fi

  if [[ ! -e "$DISABLED_MARKER" ]]; then
    marker_tmp="$(mktemp /etc/.xgs-monitor-agent-ban-sync.disabled.XXXXXX)" ||
      fail "Could not create the host opt-out marker"
    printf '# Managed by XGS Monitoring Agent.\nDisabled at %s UTC.\n' \
      "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$marker_tmp"
    chown root:root "$marker_tmp"
    chmod 0644 "$marker_tmp"
    mv -f -- "$marker_tmp" "$DISABLED_MARKER"
  fi

  if [[ -e "$UNIT_DIR/$TIMER_NAME" ]]; then
    systemctl disable --now "$TIMER_NAME" ||
      fail "Could not disable the XGS firewall-sync timer"
  fi
  if [[ -e "$UNIT_DIR/$SERVICE_NAME" ]]; then
    systemctl stop "$SERVICE_NAME" ||
      fail "Could not stop the XGS firewall-sync service"
  fi

  if [[ -e "$JAIL_FILE" || -e "$PROFILE_FILE" ]]; then
    command -v fail2ban-client >/dev/null 2>&1 ||
      fail "Fail2ban is unavailable; refusing to remove XGS firewall rules without unbanning them"
    systemctl is-active --quiet fail2ban.service ||
      fail "Fail2ban is not active; refusing to remove XGS firewall rules without inspecting the jail"
    status="$(fail2ban-client status)" ||
      fail "Could not inspect the active Fail2ban jails"
    jail_list="$(sed -n 's/.*Jail list:[[:space:]]*//p' <<<"$status" | tr -d '[:space:]')"
    [[ ",$jail_list," == *",xgs-monitor-agent,"* ]] ||
      fail "The XGS jail is not active; refusing to remove its UFW rules without inspecting them"

    jail_status="$(fail2ban-client status xgs-monitor-agent)" ||
      fail "Could not inspect the active XGS jail bans"
    printf '%s\n' "$jail_status" >"$backup_dir/xgs-monitor-agent-jail-status.txt"
    banned_text="$(sed -n 's/.*Banned IP list:[[:space:]]*//p' <<<"$jail_status")"
    if [[ -n "$banned_text" ]]; then
      read -r -a banned_ips <<<"$banned_text"
      local ip
      for ip in "${banned_ips[@]}"; do
        fail2ban-client set xgs-monitor-agent unbanip "$ip" >/dev/null ||
          fail "Could not clear an active XGS jail ban"
      done
    fi

    jail_status="$(fail2ban-client status xgs-monitor-agent)" ||
      fail "Could not verify that XGS jail bans were cleared"
    remaining_text="$(sed -n 's/.*Banned IP list:[[:space:]]*//p' <<<"$jail_status")"
    [[ -z "$remaining_text" ]] ||
      fail "XGS jail bans remain active; refusing to remove the jail configuration"
    fail2ban-client stop xgs-monitor-agent >/dev/null ||
      fail "Could not stop the XGS Fail2ban jail"
  fi

  if [[ "$nft_table_present" == true ]]; then
    nft delete table inet xgs_monitor_agent ||
      fail "Could not remove the legacy XGS nftables table"
  fi

  rm -f -- \
    "$UNIT_DIR/$SERVICE_NAME" \
    "$UNIT_DIR/$TIMER_NAME" \
    "$FAIL2BAN_DROPIN" \
    "$JAIL_FILE" \
    "$PROFILE_FILE"
  systemctl daemon-reload

  printf 'Host SSH autoban synchronization and active XGS bans were removed.\n'
  printf 'UFW defaults and unrelated rules were left unchanged; the generic sshd jail remains disabled.\n'
  printf 'Protected pre-removal backup: %s\n' "$backup_dir"
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

verify_fail2ban_jails() {
  local status jail_list
  status="$(fail2ban-client status)" ||
    fail "Could not inspect the active Fail2ban jails"
  jail_list="$(sed -n 's/.*Jail list:[[:space:]]*//p' <<<"$status" | tr -d '[:space:]')"
  [[ ",$jail_list," == *",xgs-monitor-agent,"* ]] ||
    fail "The XGS Monitoring SSH jail is not active"
  [[ ",$jail_list," != *",sshd,"* ]] ||
    fail "The default sshd jail is still active; check for a conflicting Fail2ban override"
}

if [[ "${1:-}" == "--help" ]]; then
  cat <<'HELP'
Install, migrate, or remove XGS SSH autoban enforcement via Fail2ban and UFW.

Run after the monitoring agent has been built and enrolled:
  sudo ./install-ban-sync.sh
  sudo ./install-ban-sync.sh --yes
  sudo ./update.sh --disable-ban-sync

This installs Fail2ban if needed, enables the XGS Monitoring SSH jail, disables
the generic sshd jail, configures a UFW SSH application profile, and replaces
the prior nftables policy synchronizer.
The legacy XGS nftables table is removed only after the Fail2ban policy sync
succeeds. Central Discord autoban thresholds and allowlists remain unchanged.
Use --yes only after reviewing and accepting this installation plan.
The update.sh --disable-ban-sync option creates a persistent host opt-out,
backs up the managed configuration, clears active XGS jail bans, and removes
only the XGS sync units, jail, UFW profile, and legacy nftables table.
HELP
  exit 0
fi

assume_yes=false
remove_mode=false
if [[ "${1:-}" == "--remove" ]]; then
  remove_mode=true
  shift
elif [[ "${1:-}" == "--yes" ]]; then
  assume_yes=true
  shift
fi
[[ "$#" -eq 0 ]] || fail "Unknown option: $1"
[[ "$EUID" -eq 0 ]] || fail "Run with sudo: sudo ./install-ban-sync.sh"
[[ "$SCRIPT_DIR" == "$INSTALL_DIR" ]] ||
  fail "Run this script from $INSTALL_DIR"
if [[ "$remove_mode" == true ]]; then
  remove_ban_sync
  exit 0
fi
if [[ -e "$DISABLED_MARKER" ]]; then
  managed_or_missing "$DISABLED_MARKER"
  fail "Host SSH autoban synchronization is disabled; use sudo ./update.sh --disable-ban-sync to retain the opt-out"
fi
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

managed_or_missing "$FAIL2BAN_DROPIN"
managed_or_missing "$JAIL_FILE"
managed_or_missing "$SSHD_OVERRIDE_FILE"
managed_or_missing "$PROFILE_FILE"

ports="$(configured_ssh_ports)"
printf 'This will install/configure Fail2ban and a UFW application profile for TCP ports %s.\n' "$ports"
printf 'It will enable the XGS Monitoring SSH jail and disable the generic sshd jail.\n'
printf 'It will replace the XGS sync service, add the agent account to the Fail2ban control socket group,\n'
printf 'and remove only the legacy inet xgs_monitor_agent table after a successful central-policy sync.\n'
printf 'It will not enable UFW or change its default policy.\n'
if [[ "$assume_yes" == true ]]; then
  printf 'Continuing with confirmation from the main agent installer.\n'
else
  confirm "Migrate SSH autoban enforcement to Fail2ban via UFW?" ||
    fail "Cancelled without changing the host"
fi

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
install -o root -g root -m 0644 \
  "$SCRIPT_DIR/deploy/fail2ban/jail.d/xgs-monitor-agent.local" "$SSHD_OVERRIDE_FILE"

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
verify_fail2ban_jails

systemctl start "$SERVICE_NAME" ||
  fail "Fail2ban did not apply the central policy; the legacy nftables table was left untouched"
systemctl enable --now "$TIMER_NAME"

if command -v nft >/dev/null 2>&1 &&
  nft list table inet xgs_monitor_agent >/dev/null 2>&1; then
  nft delete table inet xgs_monitor_agent
fi

printf 'Fail2ban/UFW enforcement is active and the central policy synchronizer is enabled.\n'
