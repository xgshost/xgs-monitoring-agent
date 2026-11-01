#!/usr/bin/env bash
set -euo pipefail

readonly service_user="xgs-monitor-agent"
readonly service_group="xgs-monitor-agent"
readonly service_unit="xgs-monitor-agent.service"
readonly legacy_update_timer="xgs-monitor-agent-update.timer"
readonly legacy_environment="/etc/xgs-monitor-agent.env"
readonly legacy_install_root="/opt/xgs-monitoring-agent"
readonly legacy_state_directory="/var/lib/xgs-monitor-agent"
readonly legacy_sudoers_file="/etc/sudoers.d/xgs-monitor-agent-update"
readonly legacy_ban_sync_disabled_marker="/etc/xgs-monitor-agent-ban-sync.disabled"
readonly install_root="/opt/xgs-monitor-agent-v2"
readonly state_directory="/var/lib/xgs-monitor-agent-v2"
readonly environment_file="/etc/xgs-monitor-agent-v2.env"
readonly rollback_directory="/etc/xgs-monitor-agent-v2-rollback"
readonly rollback_unit="${rollback_directory}/xgs-monitor-agent.service"
readonly main_unit_temp="/etc/systemd/system/.xgs-monitor-agent.service.v2tmp"
readonly migration_marker="/etc/xgs-monitor-agent-v2.migrated"
readonly migration_marker_temp="${migration_marker}.tmp"
readonly unit_directory="/etc/systemd/system"
readonly update_service="xgs-monitor-agent-v2-update.service"
readonly update_timer="xgs-monitor-agent-v2-update.timer"
readonly staging_directory="${install_root}/releases/.staging-bootstrap"
readonly script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

fail() {
  printf 'XGS Monitoring V1-to-V2 migration: %s\n' "$1" >&2
  exit 1
}

usage() {
  cat <<'USAGE'
Usage:
  migrate-agent-v1-to-v2-host.sh install --agent-dist-dir PATH [--server-name NAME] [--release-version VERSION] [--remove-v1-after-install]
  migrate-agent-v1-to-v2-host.sh self-check
  migrate-agent-v1-to-v2-host.sh cleanup --health-gate-passed --confirm-delete-v1-state

Run on one target host as root. Cleanup is separate and requires an external
confirmation that the central V2 heartbeat/metrics health gate passed. Install
defaults to the system FQDN from `hostname -f`.
USAGE
}

mode="${1:-install}"
if [[ "$#" -gt 0 ]]; then
  shift
fi
if [[ "$mode" == "--help" || "$mode" == "-h" ]]; then
  usage
  exit 0
fi

server_name=""
agent_dist_directory=""
release_version="2.0.0"
health_gate_passed=false
confirm_delete_v1_state=false
remove_v1_after_install=false
while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --server-name)
      [[ "$#" -ge 2 ]] || fail "--server-name requires a value."
      server_name="$2"
      shift 2
      ;;
    --agent-dist-dir)
      [[ "$#" -ge 2 ]] || fail "--agent-dist-dir requires a path."
      agent_dist_directory="$2"
      shift 2
      ;;
    --release-version)
      [[ "$#" -ge 2 ]] || fail "--release-version requires a value."
      release_version="$2"
      shift 2
      ;;
    --health-gate-passed)
      health_gate_passed=true
      shift
      ;;
    --confirm-delete-v1-state)
      confirm_delete_v1_state=true
      shift
      ;;
    --remove-v1-after-install)
      remove_v1_after_install=true
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      usage >&2
      fail "Unknown option: $1"
      ;;
  esac
done

if [[ "$mode" != "install" && "$mode" != "self-check" && "$mode" != "cleanup" ]]; then
  usage >&2
  fail "Expected install, self-check, or cleanup."
fi
if [[ "$remove_v1_after_install" == true && "$mode" != "install" ]]; then
  fail "--remove-v1-after-install is valid only with install."
fi

if [[ "$mode" == "install" ]]; then
  if [[ -z "$server_name" ]]; then
    server_name="$(hostname -f)" || fail "Could not determine the system FQDN."
  fi
  if [[ ! "$server_name" =~ ^[A-Za-z0-9][A-Za-z0-9._\ /\(\)+:-]{0,63}$ ]]; then
    fail "Provide a 1-64 character server name using letters, numbers, spaces, dots, underscores, slashes, parentheses, plus, colon, or hyphen."
  fi
  if [[ ! "$release_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.-]+)?$ ]]; then
    fail "The release version is invalid."
  fi
  if [[ -z "$agent_dist_directory" ]]; then
    fail "Provide the built V2 agent bundle with --agent-dist-dir."
  fi
fi

if [[ "${EUID}" -ne 0 ]]; then
  fail "Run as root, for example with sudo."
fi

read_environment_value() {
  local file="$1"
  local name="$2"
  local line
  local value

  if ! line="$(grep -m1 -E "^[[:space:]]*${name}=" "$file")"; then
    return 1
  fi
  value="${line#*=}"
  if [[ "$value" == \"*\" ]]; then
    value="${value:1:${#value}-2}"
  elif [[ "$value" == \'*\' ]]; then
    value="${value:1:${#value}-2}"
  elif [[ "$value" == *\"* || "$value" == *\'* ]]; then
    fail "A configured $name value has unsupported quoting."
  fi
  printf '%s' "$value"
}

normalize_api_url() {
  /usr/bin/node --input-type=commonjs - "$1" <<'NODE'
const value = process.argv[2];
let url;
try {
  url = new URL(value);
} catch {
  console.error("The monitoring URL is invalid.");
  process.exit(1);
}
if (
  url.protocol !== "https:" ||
  url.username ||
  url.password ||
  url.pathname !== "/" ||
  url.search ||
  url.hash
) {
  console.error("The monitoring URL is not compatible with V2.");
  process.exit(1);
}
process.stdout.write(url.origin);
NODE
}

check_local_v2() {
  [[ -f "$migration_marker" ]] || fail "The V2 migration marker is missing."
  [[ -s "$install_root/current/VERSION" ]] || fail "The installed V2 release metadata is missing."
  [[ -s "$state_directory/agent-token" ]] || fail "The V2 agent credential is missing."
  [[ -s "$state_directory/enrollment-request-token" ]] || fail "The V2 enrollment credential is missing."
  systemctl is-active --quiet "$service_unit" || fail "The V2 agent service is not active."
  systemctl is-active --quiet "$update_timer" || fail "The V2 update timer is not active."
  systemd-analyze verify \
    "$script_directory/systemd/xgs-monitor-agent-v2-inplace.service" \
    "$script_directory/systemd/xgs-monitor-agent-v2-update-inplace.service" \
    "$script_directory/systemd/xgs-monitor-agent-v2-update.timer"

  local api_url
  api_url="$(read_environment_value "$environment_file" XGS_MONITORING_API_URL)" ||
    fail "The V2 API URL is missing from its environment file."
  api_url="$(normalize_api_url "$api_url")" ||
    fail "The V2 API URL is invalid."
  curl --fail --silent --show-error --max-time 10 "$api_url/healthz" >/dev/null ||
    fail "The V2 Monitoring API health check failed."
  /usr/bin/node --check "$install_root/current/index.js" ||
    fail "The installed V2 agent entry point failed its syntax check."
  printf 'V2 local self-check passed: service, update timer, release metadata, credentials, unit files, agent syntax, and API health.\n'
  if [[ "$remove_v1_after_install" == true ]]; then
    printf 'V1 cleanup will proceed now; verify Discord approval and fresh heartbeat/metrics centrally afterward.\n'
  else
    printf 'Verify approval and fresh heartbeat/metrics centrally before cleanup.\n'
  fi
}

verify_v2_after_v1_removal() {
  local api_url
  systemctl is-active --quiet "$service_unit" ||
    fail "The V2 agent service is no longer active after V1 removal."
  systemctl is-active --quiet "$update_timer" ||
    fail "The V2 update timer is no longer active after V1 removal."
  api_url="$(read_environment_value "$environment_file" XGS_MONITORING_API_URL)" ||
    fail "The V2 API URL is missing after V1 removal."
  api_url="$(normalize_api_url "$api_url")" ||
    fail "The V2 API URL is invalid after V1 removal."
  curl --fail --silent --show-error --max-time 10 "$api_url/healthz" >/dev/null ||
    fail "The V2 Monitoring API health check failed after V1 removal."
  /usr/bin/node --check "$install_root/current/index.js" ||
    fail "The V2 agent entry point failed its syntax check after V1 removal."
  printf 'V2 remains active and its Monitoring API health check passed after V1 removal.\n'
}

remove_v1_sudoers_rule() {
  local temporary_file backup_file
  [[ -e "$legacy_sudoers_file" || -L "$legacy_sudoers_file" ]] || return 0
  [[ -f "$legacy_sudoers_file" && ! -L "$legacy_sudoers_file" ]] ||
    fail "The V1 updater sudoers path is not a regular file; refusing to remove it."
  if ! grep -Fq '/opt/xgs-monitoring-agent/update.sh' "$legacy_sudoers_file"; then
    return 0
  fi
  command -v visudo >/dev/null 2>&1 ||
    fail "visudo is unavailable; refusing to alter the V1 updater sudoers rule."
  visudo -c >/dev/null ||
    fail "The current sudoers configuration is invalid; refusing V1 cleanup."

  temporary_file="$(mktemp /etc/sudoers.d/.xgs-monitor-agent-update.XXXXXX)" ||
    fail "Could not create a temporary V1 updater sudoers file."
  if ! backup_file="$(mktemp /tmp/xgs-monitor-agent-sudoers.XXXXXX)"; then
    rm -f -- "$temporary_file"
    fail "Could not create a backup of the V1 updater sudoers file."
  fi
  if ! cp -p -- "$legacy_sudoers_file" "$backup_file" ||
    ! awk '!/\/opt\/xgs-monitoring-agent\/update\.sh([[:space:]]|$)/' \
      "$legacy_sudoers_file" >"$temporary_file"; then
    rm -f -- "$temporary_file" "$backup_file"
    fail "Could not prepare V1 updater sudoers cleanup."
  fi

  if grep -qvE '^[[:space:]]*(#|$)' "$temporary_file"; then
    if ! chown root:root "$temporary_file" ||
      ! chmod 0440 "$temporary_file" ||
      ! visudo -cf "$temporary_file" >/dev/null; then
      rm -f -- "$temporary_file" "$backup_file"
      fail "Remaining sudoers entries failed validation; refusing V1 cleanup."
    fi
    if ! mv -f -- "$temporary_file" "$legacy_sudoers_file"; then
      rm -f -- "$temporary_file" "$backup_file"
      fail "Could not install the cleaned V1 updater sudoers file."
    fi
  else
    rm -f -- "$temporary_file" "$legacy_sudoers_file"
  fi
  if ! visudo -c >/dev/null; then
    cp -p -- "$backup_file" "$legacy_sudoers_file" ||
      fail "Sudoers validation failed and automatic restoration also failed."
    rm -f -- "$backup_file"
    fail "Sudoers validation failed; the original updater rule was restored."
  fi
  rm -f -- "$backup_file"
}

remove_v1_installation() {
  if [[ ! -f "$legacy_install_root/install-ban-sync.sh" ]]; then
    fail "The V1 firewall-sync removal script is missing; refusing V1 cleanup."
  fi
  /bin/bash "$legacy_install_root/install-ban-sync.sh" --remove ||
    fail "Could not remove the V1 firewall autoban policy; V1 files were retained."
  rm -f -- "$legacy_ban_sync_disabled_marker"
  if systemctl is-enabled --quiet "$legacy_update_timer"; then
    systemctl disable --now "$legacy_update_timer" ||
      fail "Could not disable the V1 update timer."
  elif systemctl is-active --quiet "$legacy_update_timer"; then
    systemctl stop "$legacy_update_timer" ||
      fail "Could not stop the V1 update timer."
  fi
  remove_v1_sudoers_rule
  rm -rf -- "$legacy_install_root" "$legacy_state_directory" "$rollback_directory"
  rm -f -- \
    "$legacy_environment" \
    "$unit_directory/xgs-monitor-agent-update.service" \
    "$unit_directory/$legacy_update_timer"
  systemctl daemon-reload ||
    fail "Could not reload systemd after removing V1 update units."
  printf 'Removed the V1 checkout, state, configuration, updater units, and rollback files.\n'
}

if [[ "$mode" == "self-check" ]]; then
  check_local_v2
  exit 0
fi

if [[ "$mode" == "cleanup" ]]; then
  if [[ "$health_gate_passed" != true || "$confirm_delete_v1_state" != true ]]; then
    fail "Cleanup requires both --health-gate-passed and --confirm-delete-v1-state."
  fi
  check_local_v2
  [[ -e "$rollback_unit" ]] || fail "The saved V1 unit is missing; refusing cleanup."
  if [[ ! -t 0 ]]; then
    fail "Cleanup requires an interactive terminal for the final confirmation."
  fi
  printf 'This removes the V1 agent checkout, state, config, update units, and saved rollback unit. It does not remove monitoring history.\n'
  read -r -p "Type CLEANUP-V1-ROLLBACK to continue: " confirmation
  [[ "$confirmation" == "CLEANUP-V1-ROLLBACK" ]] || fail "Cleanup confirmation did not match."
  remove_v1_installation
  verify_v2_after_v1_removal
  printf 'V1 agent files and rollback materials were removed after the confirmed health gate.\n'
  exit 0
fi

if [[ -e "$migration_marker" ]]; then
  fail "The V2 migration marker already exists."
fi

if [[ ! -r "$legacy_environment" ]]; then
  fail "No supported V1 environment file was found."
fi

if [[ ! -f "$unit_directory/$service_unit" ]] ||
  ! grep -Eq '^ExecStart=/usr/bin/node /opt/xgs-monitoring-agent/(current/index\.js run|agent-dist/index\.js run|dist/index\.js( run)?)$' "$unit_directory/$service_unit"; then
  fail "The installed monitoring service is not the expected V1 unit."
fi

if ! v1_service_state="$(systemctl show --property=ActiveState --value "$service_unit")"; then
  fail "Could not determine the V1 monitoring service state."
fi
case "$v1_service_state" in
  active)
    ;;
  activating)
    printf 'V1 monitoring service is starting or restarting; continuing migration.\n' >&2
    ;;
  *)
    fail "The V1 monitoring service is $v1_service_state; refusing in-place replacement."
    ;;
esac

if ! id "$service_user" >/dev/null 2>&1 ||
  ! getent group "$service_group" >/dev/null; then
  fail "The existing V1 service account or group is unavailable."
fi

partial_bootstrap=false
for path in "$install_root" "$state_directory" "$environment_file" "$rollback_directory"; do
  if [[ -e "$path" || -L "$path" ]]; then
    partial_bootstrap=true
  fi
done

if [[ "$partial_bootstrap" == true ]]; then
  for path in \
    "$rollback_unit" \
    "$main_unit_temp" \
    "$migration_marker_temp" \
    "$unit_directory/$update_service" \
    "$unit_directory/$update_timer"
  do
    if [[ -e "$path" || -L "$path" ]]; then
      fail "Refusing to clean an incomplete bootstrap after service installation: $path"
    fi
  done

  for path in "$install_root" "$state_directory" "$rollback_directory"; do
    if [[ (-e "$path" || -L "$path") && ( ! -d "$path" || -L "$path" ) ]]; then
      fail "Refusing to clean an unexpected bootstrap path: $path"
    fi
  done
  if [[ -e "$environment_file" || -L "$environment_file" ]] &&
    { [[ ! -f "$environment_file" ]] || [[ -L "$environment_file" ]]; }; then
    fail "Refusing to clean an unexpected bootstrap environment path."
  fi

  for path in "$state_directory" "$rollback_directory"; do
    if [[ -d "$path" ]]; then
      if ! path_contents="$(find "$path" -mindepth 1 -print -quit)"; then
        fail "Could not verify the incomplete bootstrap directory."
      fi
      if [[ -n "$path_contents" ]]; then
        fail "Refusing to clean non-empty bootstrap state: $path"
      fi
    fi
  done

  printf 'Removing incomplete V2 bootstrap with empty state and no installed V2 service.\n' >&2
  rm -rf -- /opt/xgs-monitor-agent-v2 /var/lib/xgs-monitor-agent-v2 /etc/xgs-monitor-agent-v2-rollback
  rm -f -- /etc/xgs-monitor-agent-v2.env
fi

for path in \
  "$install_root" \
  "$state_directory" \
  "$environment_file" \
  "$rollback_directory" \
  "$main_unit_temp" \
  "$migration_marker" \
  "$migration_marker_temp" \
  "$unit_directory/$update_service" \
  "$unit_directory/$update_timer"
do
  if [[ -e "$path" || -L "$path" ]]; then
    fail "Refusing to overwrite existing V2 migration path: $path"
  fi
done

read_legacy_env_value() {
  local name="$1"
  read_environment_value "$legacy_environment" "$name"
}

legacy_api_url=""
if ! legacy_api_url="$(read_legacy_env_value XGS_MONITOR_URL)" &&
  ! legacy_api_url="$(read_legacy_env_value XGS_MONITORING_API_URL)"; then
  fail "The V1 monitoring API URL is missing from its environment file."
fi
api_url="$(normalize_api_url "$legacy_api_url")" ||
  fail "The V1 monitoring URL is not compatible with V2."

legacy_heartbeat=""
if ! legacy_heartbeat="$(read_legacy_env_value XGS_MONITOR_HEARTBEAT_INTERVAL_SECONDS)"; then
  legacy_heartbeat="$(read_legacy_env_value MONITORING_HEARTBEAT_INTERVAL_SECONDS)" || true
fi
if [[ -n "$legacy_heartbeat" ]]; then
  if [[ ! "$legacy_heartbeat" =~ ^[0-9]+$ ]] ||
    ! /usr/bin/node -e 'const n = Number(process.argv[1]); process.exit(Number.isSafeInteger(n) && n > 0 ? 0 : 1)' "$legacy_heartbeat"; then
    fail "The V1 heartbeat interval is invalid."
  fi
fi

legacy_services=""
if legacy_services="$(read_legacy_env_value XGS_MONITOR_SERVICES)"; then
  if [[ -n "$legacy_services" ]]; then
    IFS=',' read -r -a service_units <<< "$legacy_services"
    if ((${#service_units[@]} > 19)); then
      fail "The V1 monitored-service list exceeds the supported limit."
    fi
    declare -A seen_service_units=()
    for service in "${service_units[@]}"; do
      if [[ ! "$service" =~ ^[A-Za-z0-9_.@:-]{1,128}\.service$ ]] ||
        [[ -n "${seen_service_units[$service]:-}" ]]; then
        fail "The V1 monitored-service list is invalid."
      fi
      seen_service_units["$service"]=1
    done
  fi
fi

agent_dist_directory="$(realpath -e -- "$agent_dist_directory")" ||
  fail "The V2 agent bundle directory does not exist."
if [[ ! -d "$agent_dist_directory" || ! -s "$agent_dist_directory/index.js" ]]; then
  fail "The V2 agent bundle entry point is missing."
fi
if [[ "$agent_dist_directory/" == "$install_root/"* ]]; then
  fail "The V2 agent bundle must be outside the installation directory."
fi

if ! curl --fail --silent --show-error --max-time 10 \
  "$api_url/healthz" >/dev/null; then
  fail "The V2 Monitoring API health check failed."
fi

install -d -o "$service_user" -g "$service_group" -m 0755 "$install_root/releases"
install -d -o "$service_user" -g "$service_group" -m 0700 "$staging_directory"
cp -a "$agent_dist_directory/." "$staging_directory/"
if [[ ! -s "$staging_directory/index.js" ]]; then
  fail "The extracted V2 agent entry point is missing."
fi

release_hash="$(/usr/bin/node --input-type=commonjs - "$staging_directory" <<'NODE'
const { createHash } = require("node:crypto");
const { readdir, readFile } = require("node:fs/promises");
const { isAbsolute, join } = require("node:path");

const root = process.argv[2];
const maxFiles = 128;
const maxFileBytes = 2 * 1024 * 1024;
const maxReleaseBytes = 16 * 1024 * 1024;
const files = [];
let totalBytes = 0;

function validPath(path) {
  return (
    path.length > 0 &&
    path.length <= 512 &&
    !isAbsolute(path) &&
    !path.split(/[\\/]/).some((part) => part === "" || part === "." || part === "..") &&
    /^[A-Za-z0-9._/-]+$/.test(path)
  );
}

async function visit(directory, parent = "") {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const path = parent ? `${parent}/${entry.name}` : entry.name;
    if (!validPath(path)) {
      throw new Error("Agent release contains an invalid path");
    }
    if (entry.isSymbolicLink()) {
      throw new Error("Agent release contains a symbolic link");
    }
    if (entry.isDirectory()) {
      await visit(join(directory, entry.name), path);
    } else if (entry.isFile() && path.endsWith(".js")) {
      if (files.length >= maxFiles) {
        throw new Error("Agent release has too many files");
      }
      const contents = await readFile(join(directory, entry.name));
      if (contents.length > maxFileBytes) {
        throw new Error("Agent release file exceeds the size limit");
      }
      totalBytes += contents.length;
      if (totalBytes > maxReleaseBytes) {
        throw new Error("Agent release exceeds the size limit");
      }
      files.push({
        path,
        sha256: createHash("sha256").update(contents).digest("hex"),
      });
    }
  }
}

(async () => {
  await visit(root);
  if (!files.some((file) => file.path === "index.js")) {
    throw new Error("Agent release entry point is missing");
  }
  process.stdout.write(
    createHash("sha256")
      .update(
        files
          .map((file) => `${file.path}:${file.sha256}`)
          .sort()
          .join("\n"),
      )
      .digest("hex"),
  );
})().catch((error) => {
  console.error(error instanceof Error ? error.message : "Agent release is invalid");
  process.exitCode = 1;
});
NODE
)"
if [[ ! "$release_hash" =~ ^[a-f0-9]{64}$ ]]; then
  fail "Could not calculate the V2 agent release hash."
fi

release_name="${release_version}-${release_hash:0:12}"
printf '%s\n%s\n' "$release_version" "$release_hash" > "$staging_directory/VERSION"
chown -R "$service_user:$service_group" "$staging_directory"
chmod -R u=rwX,go=rX "$staging_directory"
mv "$staging_directory" "$install_root/releases/$release_name"
ln -s "releases/$release_name" "$install_root/current"
chown "$service_user:$service_group" "$install_root" "$install_root/releases"
install -d -o "$service_user" -g "$service_group" -m 0700 "$state_directory"

install -o root -g "$service_group" -m 0640 /dev/null "$environment_file"
{
  printf 'XGS_MONITORING_API_URL=%s\n' "$api_url"
  printf 'XGS_MONITORING_SERVER_NAME="%s"\n' "$server_name"
  printf 'XGS_AGENT_STATE_DIRECTORY=%s\n' "$state_directory"
  printf 'XGS_AGENT_INSTALL_DIRECTORY=%s\n' "$install_root"
  printf 'XGS_MONITOR_SSH_AUTOBAN=0\n'
  if [[ -n "$legacy_heartbeat" ]]; then
    printf 'MONITORING_HEARTBEAT_INTERVAL_SECONDS=%s\n' "$legacy_heartbeat"
  fi
  if [[ -n "$legacy_services" ]]; then
    printf 'XGS_MONITOR_SERVICES=%s\n' "$legacy_services"
  fi
} > "$environment_file"

install -d -o root -g root -m 0700 "$rollback_directory"

systemd-analyze verify \
  "$script_directory/systemd/xgs-monitor-agent-v2-inplace.service" \
  "$script_directory/systemd/xgs-monitor-agent-v2-update-inplace.service" \
  "$script_directory/systemd/xgs-monitor-agent-v2-update.timer"

enroll_environment=(
  "XGS_MONITORING_API_URL=$api_url"
  "XGS_MONITORING_SERVER_NAME=$server_name"
  "XGS_AGENT_STATE_DIRECTORY=$state_directory"
  "XGS_AGENT_INSTALL_DIRECTORY=$install_root"
  "XGS_MONITOR_SSH_AUTOBAN=0"
)
if [[ -n "$legacy_heartbeat" ]]; then
  enroll_environment+=("MONITORING_HEARTBEAT_INTERVAL_SECONDS=$legacy_heartbeat")
fi
if [[ -n "$legacy_services" ]]; then
  enroll_environment+=("XGS_MONITOR_SERVICES=$legacy_services")
fi
if ! enrollment_result="$(
  runuser -u "$service_user" -- env "${enroll_environment[@]}" \
    /usr/bin/node --preserve-symlinks-main "$install_root/current/index.js" enroll 2>&1
)"; then
  printf 'V2 enrollment failed; the V1 service remains active.\n' >&2
  printf '%s\n' "$enrollment_result" >&2
  exit 1
fi
if [[ ! "$enrollment_result" =~ \((pending|queued|active)\) ]]; then
  printf 'V2 enrollment did not return an approvable status; the V1 service remains active.\n' >&2
  printf '%s\n' "$enrollment_result" >&2
  exit 1
fi
printf '%s\n' "$enrollment_result"

rollback_v1_service() {
  if systemctl is-enabled --quiet "$update_timer"; then
    if ! systemctl disable --now "$update_timer"; then
      printf 'Warning: could not disable the V2 update timer during rollback.\n' >&2
    fi
  elif systemctl is-active --quiet "$update_timer"; then
    if ! systemctl stop "$update_timer"; then
      printf 'Warning: could not stop the V2 update timer during rollback.\n' >&2
    fi
  fi
  if ! install -o root -g root -m 0644 \
    "$rollback_unit" "$unit_directory/$service_unit"; then
    printf 'CRITICAL: could not restore the saved V1 unit.\n' >&2
    return 1
  fi
  if ! systemctl daemon-reload; then
    printf 'CRITICAL: could not reload systemd after restoring the V1 unit.\n' >&2
    return 1
  fi
  if systemctl restart "$service_unit" &&
    systemctl is-active --quiet "$service_unit"; then
    if [[ "$legacy_update_timer_was_enabled" == true ]]; then
      if ! systemctl enable --now "$legacy_update_timer"; then
        printf 'Warning: V1 service was restored, but its update timer could not be re-enabled.\n' >&2
      fi
    elif [[ "$legacy_update_timer_was_active" == true ]]; then
      if ! systemctl start "$legacy_update_timer"; then
        printf 'Warning: V1 service was restored, but its update timer could not be restarted.\n' >&2
      fi
    fi
    printf 'V1 service restored from its saved unit.\n' >&2
    return 0
  fi
  printf 'CRITICAL: automatic rollback failed; the saved V1 unit is at %s\n' \
    "$rollback_unit" >&2
  return 1
}

install -o root -g root -m 0600 \
  "$unit_directory/$service_unit" "$rollback_unit"
install -o root -g root -m 0644 \
  "$script_directory/systemd/xgs-monitor-agent-v2-update-inplace.service" \
  "$unit_directory/$update_service"
install -o root -g root -m 0644 \
  "$script_directory/systemd/xgs-monitor-agent-v2-update.timer" \
  "$unit_directory/$update_timer"
install -o root -g root -m 0644 \
  "$script_directory/systemd/xgs-monitor-agent-v2-inplace.service" \
  "$main_unit_temp"

legacy_update_timer_was_enabled=false
legacy_update_timer_was_active=false
if systemctl is-enabled --quiet "$legacy_update_timer"; then
  legacy_update_timer_was_enabled=true
fi
if systemctl is-active --quiet "$legacy_update_timer"; then
  legacy_update_timer_was_active=true
fi
if [[ "$legacy_update_timer_was_enabled" == true || "$legacy_update_timer_was_active" == true ]]; then
  if ! systemctl disable --now "$legacy_update_timer"; then
    if [[ "$legacy_update_timer_was_enabled" == true ]]; then
      systemctl enable --now "$legacy_update_timer" ||
        printf 'Warning: could not restore the V1 update timer.\n' >&2
    elif [[ "$legacy_update_timer_was_active" == true ]]; then
      systemctl start "$legacy_update_timer" ||
        printf 'Warning: could not restart the V1 update timer.\n' >&2
    fi
    fail "Could not disable the V1 update timer; the V1 service remains active."
  fi
fi

if ! mv -T "$main_unit_temp" "$unit_directory/$service_unit"; then
  if [[ "$legacy_update_timer_was_enabled" == true ]]; then
    systemctl enable --now "$legacy_update_timer" ||
      printf 'Warning: could not restore the V1 update timer.\n' >&2
  elif [[ "$legacy_update_timer_was_active" == true ]]; then
    systemctl start "$legacy_update_timer" ||
      printf 'Warning: could not restart the V1 update timer.\n' >&2
  fi
  fail "Could not install the V2 service unit; the V1 service remains active."
fi

if ! systemctl daemon-reload; then
  printf 'Systemd could not reload the V2 unit; restoring the saved V1 unit.\n' >&2
  rollback_v1_service
  exit 1
fi

if ! systemctl restart "$service_unit" ||
  ! systemctl is-active --quiet "$service_unit"; then
  printf 'V2 service did not start; restoring the saved V1 unit.\n' >&2
  rollback_v1_service
  exit 1
fi

if ! systemctl enable --now "$update_timer"; then
  printf 'V2 update timer did not start; restoring the saved V1 unit.\n' >&2
  rollback_v1_service
  exit 1
fi

if ! install -o root -g root -m 0644 /dev/null "$migration_marker_temp" ||
  ! printf 'version=%s\n' "$release_version" > "$migration_marker_temp" ||
  ! mv -T "$migration_marker_temp" "$migration_marker"; then
  printf 'Could not write the migration marker; restoring the saved V1 unit.\n' >&2
  if [[ -e "$migration_marker_temp" ]]; then
    if ! rm -f -- "$migration_marker_temp"; then
      printf 'Warning: could not remove the incomplete migration marker temp file.\n' >&2
    fi
  fi
  rollback_v1_service
  exit 1
fi

printf 'V2 service: %s\n' "$(systemctl is-active "$service_unit")"
printf 'V2 update timer: %s\n' "$(systemctl is-active "$update_timer")"
check_local_v2
if [[ "$remove_v1_after_install" == true ]]; then
  remove_v1_installation
  verify_v2_after_v1_removal
  printf 'V2 migration and V1 removal completed successfully.\n'
else
  echo "V1 was replaced in place. V1 files and state are retained for rollback; do not run the V1 updater."
fi
