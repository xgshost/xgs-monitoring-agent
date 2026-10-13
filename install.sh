#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

readonly INSTALL_DIR="/opt/xgs-monitoring-agent"
readonly SERVICE_USER="xgs-monitor-agent"
readonly ENV_FILE="/etc/xgs-monitor-agent.env"
readonly UNIT_FILE="/etc/systemd/system/xgs-monitor-agent.service"
readonly UNIT_DROPIN_DIR="/etc/systemd/system/xgs-monitor-agent.service.d"
readonly STATE_FILE="/var/lib/xgs-monitor-agent/credentials.json"
readonly NODE_SOURCE_KEYRING="/usr/share/keyrings/xgs-nodesource.gpg"
readonly NODE_SOURCE_FILE="/etc/apt/sources.list.d/xgs-nodesource-node22.sources"
readonly NODE_SOURCE_FINGERPRINT="6F71F525282841EEDAF851B42F59B5F99B1BE0B4"
readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"

fail() {
  printf 'Installer error: %s\n' "$1" >&2
  exit 1
}

confirm() {
  local answer
  read -r -p "$1 [y/N] " answer </dev/tty
  [[ "$answer" =~ ^[Yy]([Ee][Ss])?$ ]]
}

if [[ "${1:-}" == "--help" ]]; then
  cat <<'HELP'
Install the XGS Monitoring Agent on Debian or Ubuntu.

Run from /opt/xgs-monitoring-agent:
  sudo ./install.sh

The installer requires an interactive terminal to collect the service URL,
one-use enrollment token, and explicit journal-read permission consent.
HELP
  exit 0
fi

[[ "$#" -eq 0 ]] || fail "Unknown option: $1"
[[ "$EUID" -eq 0 ]] || fail "Run with sudo: sudo ./install.sh"
[[ -f /etc/os-release ]] || fail "Cannot identify this operating system"
# shellcheck disable=SC1091
. /etc/os-release
[[ "${ID:-}" == "ubuntu" || "${ID:-}" == "debian" ]] ||
  fail "Only Debian and Ubuntu are supported"
[[ "$SCRIPT_DIR" == "$INSTALL_DIR" ]] ||
  fail "Clone the agent to $INSTALL_DIR before running this installer"
[[ -f "$SCRIPT_DIR/package-lock.json" && -f "$SCRIPT_DIR/package.json" ]] ||
  fail "Agent package files are missing"
[[ -f "$SCRIPT_DIR/deploy/systemd/xgs-monitor-agent.service" ]] ||
  fail "The systemd unit file is missing"
command -v systemctl >/dev/null || fail "systemd is required"
command -v apt-get >/dev/null || fail "APT is required"
command -v runuser >/dev/null || fail "runuser is required"
getent passwd nobody >/dev/null || fail "The unprivileged nobody account is required"
getent group nogroup >/dev/null || fail "The unprivileged nogroup is required"
unit_load_state="$(systemctl show --property=LoadState --value xgs-monitor-agent.service)"
[[ "$unit_load_state" == "not-found" ]] ||
  fail "An xgs-monitor-agent systemd unit is already installed; refusing to replace it"

for path in "$ENV_FILE" "$UNIT_FILE" "$UNIT_DROPIN_DIR"; do
  [[ ! -e "$path" ]] ||
    fail "$path already exists; refusing to overwrite existing configuration"
done
[[ ! -e "$SCRIPT_DIR/dist" ]] ||
  fail "$SCRIPT_DIR/dist already exists; refusing to overwrite existing build output"
if getent passwd "$SERVICE_USER" >/dev/null; then
  fail "The $SERVICE_USER account already exists; refusing to modify it"
fi

architecture="$(dpkg --print-architecture)"
case "$architecture" in
  amd64|arm64|armhf) ;;
  *) fail "NodeSource does not support architecture $architecture" ;;
esac

node_version=""
if command -v node >/dev/null 2>&1; then
  node_version="$(node --version)"
  if [[ "$node_version" != v22.* ]]; then
    confirm "Node.js $node_version is installed. Installing Node.js 22 may replace it. Continue?" ||
      fail "Stopped without changing Node.js"
  fi
fi

printf 'This will install Node.js 22 from NodeSource, build and test the agent,\n'
printf 'create its unprivileged service account, save enrollment credentials,\n'
printf 'and enable the systemd service. It will not execute remote commands.\n'
confirm "Continue with the installation?" || fail "Cancelled"

monitor_url=""
read -r -p "Monitoring HTTPS URL from /enroll: " monitor_url </dev/tty
[[ "$monitor_url" =~ ^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?(/[A-Za-z0-9._~/-]*)?$ ]] ||
  fail "Enter an HTTPS URL with a hostname, optional port, and simple path only"

enrollment_token=""
read -r -s -p "One-use enrollment token from /enroll (input hidden): " enrollment_token </dev/tty
printf '\n'
[[ "$enrollment_token" =~ ^[A-Za-z0-9_-]{43}$ ]] ||
  fail "The enrollment token format is invalid"

getent group systemd-journal >/dev/null ||
  fail "The systemd-journal group is missing; verify journal access for this host"
printf 'Adding the agent to systemd-journal grants it read access to all system journal entries.\n'
printf 'The agent itself processes only SSH and sudo authentication entries.\n'
confirm "Approve journal-read access for $SERVICE_USER on this host?" ||
  fail "Stopped without granting journal access"

temp_dir="$(mktemp -d "${TMPDIR:-/tmp}/xgs-monitor-agent-install.XXXXXX")"
build_dir=""
cleanup_build() {
  if [[ -n "$build_dir" && -d "$build_dir" ]]; then
    rm -rf -- "$build_dir"
  fi
}
trap 'cleanup_build; rm -f "$temp_dir/nodesource-key.asc" "$temp_dir/nodesource-keyring.gpg" "$temp_dir/nodesource.sources"; rmdir "$temp_dir" 2>/dev/null || true' EXIT

if command -v node >/dev/null 2>&1 && [[ "$(node --version)" == v22.* ]] &&
  command -v npm >/dev/null 2>&1; then
  printf 'Using existing Node.js %s and npm.\n' "$(node --version)"
else
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl gnupg

  if [[ -e "$NODE_SOURCE_FILE" || -e "$NODE_SOURCE_KEYRING" ]]; then
    [[ -f "$NODE_SOURCE_FILE" && -f "$NODE_SOURCE_KEYRING" ]] ||
      fail "A partial XGS NodeSource configuration exists; inspect it before continuing"
    grep -Fqx 'URIs: https://deb.nodesource.com/node_22.x' "$NODE_SOURCE_FILE" ||
      fail "Existing $NODE_SOURCE_FILE is not the expected Node.js 22 source"
    fingerprint="$(gpg --show-keys --with-colons "$NODE_SOURCE_KEYRING" 2>/dev/null |
      awk -F: '$1 == "fpr" { print $10; exit }')"
    [[ "$fingerprint" == "$NODE_SOURCE_FINGERPRINT" ]] ||
      fail "Existing NodeSource key fingerprint does not match"
  else
    if grep -RqsF 'https://deb.nodesource.com/node_22.x' \
      /etc/apt/sources.list /etc/apt/sources.list.d 2>/dev/null; then
      fail "A Node.js 22 NodeSource entry already exists outside the installer-managed file; inspect it before continuing"
    fi

    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
      -o "$temp_dir/nodesource-key.asc"
    fingerprint="$(gpg --show-keys --with-colons "$temp_dir/nodesource-key.asc" 2>/dev/null |
      awk -F: '$1 == "fpr" { print $10; exit }')"
    [[ "$fingerprint" == "$NODE_SOURCE_FINGERPRINT" ]] ||
      fail "Downloaded NodeSource key fingerprint does not match"
    gpg --batch --yes --dearmor \
      --output "$temp_dir/nodesource-keyring.gpg" "$temp_dir/nodesource-key.asc"
    install -d -o root -g root -m 0755 /usr/share/keyrings
    install -o root -g root -m 0644 \
      "$temp_dir/nodesource-keyring.gpg" "$NODE_SOURCE_KEYRING"

    cat >"$temp_dir/nodesource.sources" <<SOURCES
Types: deb
URIs: https://deb.nodesource.com/node_22.x
Suites: nodistro
Components: main
Architectures: $architecture
Signed-By: $NODE_SOURCE_KEYRING
SOURCES
    install -o root -g root -m 0644 \
      "$temp_dir/nodesource.sources" "$NODE_SOURCE_FILE"
  fi

  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs
fi

[[ "$(node --version)" == v22.* ]] ||
  fail "Expected Node.js 22 after installation; found $(node --version)"
command -v npm >/dev/null || fail "npm was not installed with Node.js"

cd "$INSTALL_DIR"
build_dir="$(mktemp -d "${TMPDIR:-/var/tmp}/xgs-monitor-agent-build.XXXXXX")"
install -d -o nobody -g nogroup -m 0700 "$build_dir/home"
cp -a install.sh package.json package-lock.json tsconfig.json src test "$build_dir/"
chown -R nobody:nogroup "$build_dir"
runuser -u nobody -- env HOME="$build_dir/home" \
  npm --prefix "$build_dir" ci --ignore-scripts
runuser -u nobody -- env HOME="$build_dir/home" \
  npm --prefix "$build_dir" run build
runuser -u nobody -- env HOME="$build_dir/home" \
  npm --prefix "$build_dir" test
install -d -o root -g root -m 0755 "$SCRIPT_DIR/dist"
cp -a "$build_dir/dist/." "$SCRIPT_DIR/dist/"
chown -R root:root "$SCRIPT_DIR/dist"
chmod -R u=rwX,go=rX "$SCRIPT_DIR/dist"
cleanup_build
build_dir=""

getent passwd "$SERVICE_USER" >/dev/null &&
  fail "The $SERVICE_USER account appeared during installation"
useradd --system --user-group --no-create-home --home-dir /nonexistent \
  --shell /usr/sbin/nologin "$SERVICE_USER"
install -d -o root -g root -m 0755 "$UNIT_DROPIN_DIR"
cat >"$UNIT_DROPIN_DIR/journal-access.conf" <<'UNIT'
[Service]
SupplementaryGroups=systemd-journal
UNIT
chmod 0644 "$UNIT_DROPIN_DIR/journal-access.conf"

install -o root -g root -m 0600 /dev/null "$ENV_FILE"
printf 'XGS_MONITOR_URL=%s\nXGS_MONITOR_ENROLLMENT_TOKEN=%s\n' \
  "$monitor_url" "$enrollment_token" >"$ENV_FILE"
unset enrollment_token
install -o root -g root -m 0644 \
  "$SCRIPT_DIR/deploy/systemd/xgs-monitor-agent.service" "$UNIT_FILE"

systemctl daemon-reload
systemctl enable --now xgs-monitor-agent

printf 'Waiting for enrollment to complete (up to 90 seconds)...\n'
enrolled=false
for ((attempt = 0; attempt < 45; attempt++)); do
  if [[ -f "$STATE_FILE" ]] &&
    grep -Eq '"enrollmentAccepted"[[:space:]]*:[[:space:]]*true' "$STATE_FILE"; then
    enrolled=true
    break
  fi
  sleep 2
done

if [[ "$enrolled" == true ]]; then
  temp_env="$(mktemp /etc/.xgs-monitor-agent.env.XXXXXX)"
  awk -F= '$1 != "XGS_MONITOR_ENROLLMENT_TOKEN" { print }' "$ENV_FILE" >"$temp_env"
  chown root:root "$temp_env"
  chmod 0600 "$temp_env"
  mv -f "$temp_env" "$ENV_FILE"
  unset monitor_url
  systemctl restart xgs-monitor-agent
  systemctl is-active --quiet xgs-monitor-agent ||
    fail "Enrollment succeeded but the agent service is not active"
  printf 'Enrollment completed. The one-use token was removed from %s.\n' "$ENV_FILE"
else
  printf 'Enrollment has not completed yet; the enrollment token remains in %s for retry.\n' "$ENV_FILE" >&2
  printf 'Check service logs with: journalctl -u xgs-monitor-agent -n 50 --no-pager\n' >&2
  exit 1
fi

printf 'Agent enrollment succeeded and its heartbeat service is active.\n'
