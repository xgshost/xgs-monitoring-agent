apt_update_failure_is_only_pbs_enterprise_401() {
  awk '
    BEGIN {
      repository = "https://enterprise.proxmox.com/debian/pbs"
    }
    /^Err:/ {
      if (index($0, repository " ") == 0) {
        unexpected = 1
      }
      err_count++
      next
    }
    /^E: Failed to fetch / {
      if (index($0, repository "/") == 0 || index($0, "401 Unauthorized") == 0) {
        unexpected = 1
      }
      fetch_count++
      next
    }
    /^E: The repository / {
      if (index($0, repository " ") == 0 || index($0, "is not signed.") == 0) {
        unexpected = 1
      }
      unsigned_count++
      next
    }
    /^E: Some index files failed to download\./ { next }
    /^E:/ { unexpected = 1 }
    END {
      if (unexpected || err_count == 0 || fetch_count == 0 || unsigned_count == 0) {
        exit 1
      }
      exit 0
    }
  ' "$1"
}

apt_update() {
  local output_file status
  output_file="$(mktemp "${TMPDIR:-/tmp}/xgs-agent-apt-update.XXXXXX")"

  if apt-get update >"$output_file" 2>&1; then
    cat "$output_file"
    rm -f -- "$output_file"
    return 0
  else
    status=$?
  fi

  cat "$output_file" >&2
  if apt_update_failure_is_only_pbs_enterprise_401 "$output_file"; then
    printf '%s\n' \
      "Warning: continuing despite the unauthorized PBS Enterprise repository; other APT update failures remain fatal. Repository configuration was not changed." \
      >&2
    rm -f -- "$output_file"
    return 0
  fi

  rm -f -- "$output_file"
  return "$status"
}
