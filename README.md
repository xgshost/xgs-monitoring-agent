# XGS Monitoring Agent

The lightweight agent reports heartbeats, structured SSH and sudo
authentication events, versioned OS/hardware telemetry, and centrally
allowlisted Docker container state to the XGS monitoring service over outbound
HTTPS. It reports Docker container names only to support admin command
autocomplete; state inspection remains limited to centrally allowlisted names.
It does not send container logs or environment variables. It runs as an
unprivileged systemd service and does not execute commands remotely.

## Requirements

- Debian or Ubuntu with systemd and `journalctl`
- Node.js 22 and npm
- An administrator-approved way for the agent user to read authentication
  journal entries

## Install

1. Run `/enroll` in the monitoring Discord server and keep the one-use token
   private. The command returns `XGS_MONITOR_URL` and
   `XGS_MONITOR_ENROLLMENT_TOKEN`.
2. On the monitored server, clone this public agent-only repository and run
   its installer:

   ```sh
   git clone https://github.com/xgshost/xgs-monitoring-agent.git /opt/xgs-monitoring-agent
   cd /opt/xgs-monitoring-agent
   sudo ./install.sh
   ```

The installer verifies Debian/Ubuntu, installs Node.js 22 through the signed
NodeSource APT repository when needed, builds and tests the agent, creates its
non-root service account, installs the systemd unit, and starts the service. It
prompts for the monitoring URL and one-use token without echoing the token. On
hosts with the Docker CLI and `docker` group, it also asks whether to grant the
agent Docker access; this is root-equivalent access to that host.

Before granting journal access, it explains that the
`systemd-journal` group permits reading all system journal entries; the agent
itself processes structured SSH authentication and sudo authentication-failure
entries only. Sudo alerts use the invoking login name or UID and do not forward
raw journal messages, commands, terminals, or working directories. Approve
journal access separately for each host. If enrollment succeeds, the installer
removes the spent token from the protected environment file. If it times out,
the token remains there so the agent can retry; inspect the service logs before
requesting a new token.

Operational errors are written as structured JSON lines next to the agent state
file and forwarded to the central receiver after enrollment. Reports contain
only an operation name, a sanitized error code, and a timestamp—not raw error
messages or credentials. The local file is capped at 1 MiB with one rotated
copy; it remains available if the central server cannot be reached.

Telemetry includes CPU utilization/load, memory and swap, per-filesystem space
and inode usage, uptime, OS/kernel version, CPU and block-device inventory,
agent version, boot ID, Docker daemon state when installed, and optional
systemd service states. Container monitoring is controlled centrally with
`/docker-watch`; the agent queries only centrally allowlisted names and reads
container state, configured health-check status, and restart counts. It does
not collect container logs or environment variables. A separate name-only
inventory is sent to support container autocomplete. Docker socket access is
granted only after explicit approval. For an already-installed agent, update
the repository first, then run `sudo ./install.sh --enable-docker-watch` from
`/opt/xgs-monitoring-agent`; this adds the agent to the Docker group and
restarts its service. Docker access failures are reported as unavailable
telemetry, not as missing containers.
To monitor additional systemd services, add a comma-separated allowlist such as
`XGS_MONITOR_SERVICES=nginx.service,pteroq.service` to
`/etc/xgs-monitor-agent.env`, then restart the agent.

The central service schedules OS, Hardware, and General history reports at
15-minute, daily, and hourly intervals. Older agents continue heartbeat and
SSH reporting, but do not report sudo failures or provide telemetry until
manually updated.

## Optional SSH autoban enforcement

After the agent is installed, built, and enrolled, install the Fail2ban/UFW
policy synchronizer on each host:

```sh
sudo ./install-ban-sync.sh
```

The installer offers to install Fail2ban through APT on Debian and Ubuntu when
it is missing. It requires UFW to already be active, creates a dedicated UFW
application profile for the configured SSH ports, and uses Fail2ban's UFW
action to enforce centrally managed bans. It does not enable UFW or change its
default policy. The existing global threshold, escalation, Discord controls,
and allowlist remain in the central service.

The central policy synchronizer runs as `xgs-monitor-agent` without
`CAP_NET_ADMIN`. A dedicated group grants it access to Fail2ban's local control
socket; a Fail2ban systemd drop-in applies group access to the socket after
startup. Fail2ban performs UFW changes. A local Fail2ban ban lasts at most 24
hours; the once-per-minute synchronizer reapplies it while the central policy
remains active, allowing central bans of up to 30 days. If central policy
sync is unavailable for longer than the local Fail2ban ban lifetime, the
local ban can expire until synchronization recovers. Central expiry, manual
unban, and allowlisting are reconciled by the timer.

During migration, the installer removes only the legacy
`inet xgs_monitor_agent` nftables table, and only after a successful Fail2ban
policy sync. Existing UFW rules and defaults are not reset.

## Update

The updater is manual; the agent never updates itself. For the first update on
an existing installation, pull the updater and run it:

```sh
sudo bash -c 'git -C /opt/xgs-monitoring-agent pull --ff-only origin main && /opt/xgs-monitoring-agent/update.sh --rebuild-current'
```

For later updates, run:

```sh
sudo /opt/xgs-monitoring-agent/update.sh
```

The updater refuses dirty or non-`main` checkouts, pulls only fast-forward
changes, and builds/tests before restarting the service. It does not discard
local changes or configure passwordless sudo. The agent has no remote shell or
server-control feature. It prints concise progress, with detailed command
output shown only when a step fails.

## Optional automatic updates

Automatic updates are disabled by default. To opt in to a daily check with a
random delay of up to 30 minutes:

```sh
sudo /opt/xgs-monitoring-agent/auto-update.sh enable
```

Enable the timer only after completing the first update above.

Check or disable the timer with:

```sh
sudo /opt/xgs-monitoring-agent/auto-update.sh status
sudo /opt/xgs-monitoring-agent/auto-update.sh disable
```

The timer uses the same fast-forward, build, and test checks as the manual
updater. It skips commits that were already updated successfully and retries
after a failed run, even if `main` has not advanced. It restarts the agent only
after a successful build and test. The systemd updater runs as root to update
the root-owned checkout and restart the service; this also means Git and npm
scripts from `main` execute as root when an update is available. Enable it only
if automatic deployment from that branch is acceptable.
