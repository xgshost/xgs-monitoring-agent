# XGS Monitoring Agent

The lightweight agent reports heartbeats, structured SSH and sudo
authentication events, and versioned OS/hardware telemetry to the XGS
monitoring service over outbound HTTPS. It runs as an unprivileged systemd
service and does not execute commands remotely.

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
prompts for the monitoring URL and one-use token without echoing the token.

Before granting journal access, it explains that the
`systemd-journal` group permits reading all system journal entries; the agent
itself processes structured SSH authentication and sudo authentication-failure
entries only. Sudo alerts use the invoking login name or UID and do not forward
raw journal messages, commands, terminals, or working directories. Approve
journal access separately for each host. If enrollment succeeds, the installer
removes the spent token from the protected environment file. If it times out,
the token remains there so the agent can retry; inspect the service logs before
requesting a new token.

Telemetry includes CPU utilization/load, memory and swap, per-filesystem space
and inode usage, uptime, OS/kernel version, CPU and block-device inventory,
agent version, boot ID, Docker daemon state when installed, and optional
systemd service states. Docker container details are not collected, and the
agent is not granted Docker socket access. To monitor additional systemd
services, add a comma-separated allowlist such as
`XGS_MONITOR_SERVICES=nginx.service,pteroq.service` to
`/etc/xgs-monitor-agent.env`, then restart the agent.

The central service schedules OS, Hardware, and General history reports at
15-minute, daily, and hourly intervals. Older agents continue heartbeat and
SSH reporting, but do not report sudo failures or provide telemetry until
manually updated.

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
server-control feature.

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
