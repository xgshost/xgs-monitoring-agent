#!/usr/bin/env bash

ensure_update_sudoers_rule() {
  local invoking_user="${SUDO_USER:-}"
  local sudoers_directory="/etc/sudoers.d"
  local sudoers_file="${sudoers_directory}/xgs-monitor-agent-update"
  local rule disable_rule temporary_file backup_file=""

  if [[ -z "$invoking_user" || "$invoking_user" == "root" ]]; then
    printf 'Updater permission: no non-root sudo caller; skipped.\n'
    return 0
  fi

  if [[ ! "$invoking_user" =~ ^[A-Za-z_][A-Za-z0-9_.-]*$ ]] ||
    ! getent passwd "$invoking_user" >/dev/null; then
    printf 'Updater permission: invalid or unknown caller; refusing to add a rule.\n' >&2
    return 1
  fi

  if ! command -v visudo >/dev/null 2>&1; then
    printf 'Updater permission: visudo is unavailable; no rule was added.\n' >&2
    return 1
  fi

  if [[ ! -d "$sudoers_directory" ]] ||
    ! grep -Eq '^[[:space:]]*[@#]includedir[[:space:]]+/etc/sudoers\.d([[:space:]]|$)' /etc/sudoers; then
    printf 'Updater permission: /etc/sudoers.d is not available or included.\n' >&2
    return 1
  fi

  if ! visudo -c >/dev/null 2>&1; then
    printf 'Updater permission: existing sudoers configuration is invalid; no change made.\n' >&2
    visudo -c >&2
    return 1
  fi

  rule="${invoking_user} ALL=(root) NOPASSWD: /opt/xgs-monitoring-agent/update.sh \"\""
  disable_rule="${invoking_user} ALL=(root) NOPASSWD: /opt/xgs-monitoring-agent/update.sh --disable-ban-sync"
  if [[ -L "$sudoers_file" ]] ||
    { [[ -e "$sudoers_file" ]] && [[ ! -f "$sudoers_file" ]]; }; then
    printf 'Updater permission: %s is not a regular file; no change made.\n' "$sudoers_file" >&2
    return 1
  fi

  if [[ -f "$sudoers_file" ]] &&
    grep -Fqx -- "$rule" "$sudoers_file" &&
    grep -Fqx -- "$disable_rule" "$sudoers_file"; then
    printf 'Updater permission already exists for %s.\n' "$invoking_user"
    return 0
  fi

  temporary_file="$(mktemp "${sudoers_directory}/.xgs-monitor-agent-update.XXXXXX")" || {
    printf 'Updater permission: could not create a temporary sudoers file.\n' >&2
    return 1
  }

  if [[ -f "$sudoers_file" ]]; then
    backup_file="$(mktemp "${TMPDIR:-/tmp}/xgs-monitor-agent-sudoers.XXXXXX")" || {
      rm -f -- "$temporary_file"
      printf 'Updater permission: could not create a sudoers backup.\n' >&2
      return 1
    }
    if ! cp -p -- "$sudoers_file" "$backup_file" ||
      ! cat -- "$sudoers_file" >"$temporary_file"; then
      rm -f -- "$temporary_file" "$backup_file"
      printf 'Updater permission: could not prepare the sudoers file.\n' >&2
      return 1
    fi
    printf '\n' >>"$temporary_file"
  else
    : >"$temporary_file"
  fi
  for rule in \
    "${invoking_user} ALL=(root) NOPASSWD: /opt/xgs-monitoring-agent/update.sh \"\"" \
    "${invoking_user} ALL=(root) NOPASSWD: /opt/xgs-monitoring-agent/update.sh --disable-ban-sync"; do
    if ! grep -Fqx -- "$rule" "$temporary_file"; then
      printf '%s\n' "$rule" >>"$temporary_file"
    fi
  done

  if ! chown root:root "$temporary_file" || ! chmod 0440 "$temporary_file"; then
    rm -f -- "$temporary_file" "$backup_file"
    printf 'Updater permission: could not set secure sudoers file ownership or mode.\n' >&2
    return 1
  fi

  if ! visudo -cf "$temporary_file" >/dev/null 2>&1; then
    printf 'Updater permission: generated rule failed validation; no change made.\n' >&2
    visudo -cf "$temporary_file" >&2
    rm -f -- "$temporary_file" "$backup_file"
    return 1
  fi

  if ! mv -f -- "$temporary_file" "$sudoers_file"; then
    rm -f -- "$temporary_file" "$backup_file"
    printf 'Updater permission: could not install the sudoers rule.\n' >&2
    return 1
  fi

  if ! visudo -c >/dev/null 2>&1; then
    printf 'Updater permission: final sudoers validation failed; restoring the prior file.\n' >&2
    if [[ -n "$backup_file" ]]; then
      if ! cp -p -- "$backup_file" "$sudoers_file"; then
        printf 'Updater permission: rollback failed; inspect %s manually.\n' "$sudoers_file" >&2
        rm -f -- "$backup_file"
        return 1
      fi
    elif ! rm -f -- "$sudoers_file"; then
      printf 'Updater permission: rollback failed; inspect %s manually.\n' "$sudoers_file" >&2
      return 1
    fi
    visudo -c >&2
    rm -f -- "$backup_file"
    return 1
  fi

  rm -f -- "$backup_file"
  printf 'Added passwordless updater permissions for %s.\n' "$invoking_user"
}
