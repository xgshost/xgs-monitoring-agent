# XGS Monitoring Agent

The lightweight agent reports heartbeats and structured SSH authentication
events to the XGS monitoring service over outbound HTTPS. It runs as an
unprivileged systemd service and does not execute commands remotely.

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
