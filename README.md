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
2. On the monitored server, clone this public agent-only repository and build:

   ```sh
   git clone https://github.com/xgshost/xgs-monitoring-agent.git /opt/xgs-monitoring-agent
   cd /opt/xgs-monitoring-agent
   npm ci
   npm run build
   ```

3. Create the unprivileged service user and protected environment file:

   ```sh
   sudo useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin xgs-monitor-agent
   sudo install -o root -g xgs-monitor-agent -m 0640 /dev/null /etc/xgs-monitor-agent.env
   sudoedit /etc/xgs-monitor-agent.env
   ```

   Add the two values returned by `/enroll`. Do not put the enrollment token in
   shell history or share it. The agent saves its exchanged credential under
   `/var/lib/xgs-monitor-agent/` with owner-only permissions. Remove the
   enrollment token from the environment file after enrollment succeeds.

4. Journal access must be approved for each host before changing permissions.
   On systems where `systemd-journal` is the appropriate read-access group,
   an administrator can grant access with:

   ```sh
   sudo usermod -aG systemd-journal xgs-monitor-agent
   ```

   This group may expose journal entries from all services to the agent; the
   agent itself only processes SSH authentication entries. Keep the service
   unprivileged.

5. Install and start the systemd unit:

   ```sh
   sudo install -o root -g root -m 0644 deploy/systemd/xgs-monitor-agent.service /etc/systemd/system/xgs-monitor-agent.service
   sudo systemctl daemon-reload
   sudo systemctl enable --now xgs-monitor-agent
   ```

## Update

Run updates manually as an administrator:

```sh
cd /opt/xgs-monitoring-agent
git pull --ff-only
npm ci
npm run build
sudo systemctl restart xgs-monitor-agent
```

The agent has no self-update, remote shell, or server-control feature.
