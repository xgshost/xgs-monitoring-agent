# XGS Monitoring Agent

The lightweight agent reports heartbeats, structured SSH authentication
events, and versioned OS/hardware telemetry to the XGS monitoring service over
outbound HTTPS. It runs as an unprivileged systemd service and does not execute
commands remotely.

## Requirements

- Debian or Ubuntu with systemd and `journalctl`
- Node.js 22 and npm
- An administrator-approved way for the agent user to read SSH journal entries

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
itself processes only SSH authentication entries. Approve this separately for
each host. If enrollment succeeds, the installer removes the spent token from
the protected environment file. If it times out, the token remains there so
the agent can retry; inspect the service logs before requesting a new token.

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
SSH reporting, but do not provide telemetry until manually updated.

## Update

Run updates manually as an administrator:

```sh
cd /opt/xgs-monitoring-agent
git pull --ff-only
npm ci
npm run build
npm test
npm prune --omit=dev
sudo systemctl restart xgs-monitor-agent
```

The agent has no self-update, remote shell, or server-control feature.
