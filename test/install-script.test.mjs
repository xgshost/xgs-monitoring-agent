import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { accessSync, constants, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const installerPath = fileURLToPath(new URL("../install.sh", import.meta.url));
const banInstallerPath = fileURLToPath(
  new URL("../install-ban-sync.sh", import.meta.url),
);
const banServicePath = fileURLToPath(
  new URL(
    "../deploy/systemd/xgs-monitor-agent-firewall-sync.service",
    import.meta.url,
  ),
);

test("agent installer is executable, syntactically valid, and documents usage", () => {
  assert.doesNotThrow(() => accessSync(installerPath, constants.X_OK));
  const installerSource = readFileSync(installerPath, "utf8");
  assert.match(installerSource, /source "\$SCRIPT_DIR\/apt-update\.sh"/);
  assert.match(installerSource, /trap report_unhandled_failure ERR/);
  assert.match(installerSource, /chmod -R u=rwX,go=rX "\$SCRIPT_DIR\/dist"/);
  assert.match(installerSource, /X   X   GGGGG   SSSSS/);
  assert.match(installerSource, /source "\$SCRIPT_DIR\/update-sudoers\.sh"/);
  assert.match(installerSource, /ensure_update_sudoers_rule/);
  assert.match(installerSource, /^  update-sudoers\.sh \\$/m);
  assert.match(installerSource, /^  update\.sh \\$/m);
  assert.match(installerSource, /^  auto-update\.sh \\$/m);
  assert.match(installerSource, /^  install-ban-sync\.sh \\$/m);
  assert.match(installerSource, /^  reenroll\.sh \\$/m);
  assert.match(installerSource, /^  deploy \\$/m);
  assert.match(installerSource, /^  sudo \.\/install\.sh --enable-docker-watch$/m);
  assert.match(
    installerSource,
    /usermod --append --groups docker "\$SERVICE_USER"/,
  );

  const syntaxCheck = spawnSync("bash", ["-n", installerPath], {
    encoding: "utf8",
  });
  assert.equal(syntaxCheck.status, 0, syntaxCheck.stderr);

  const help = spawnSync(installerPath, ["--help"], { encoding: "utf8" });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /sudo \.\/install\.sh/);
  assert.match(help.stdout, /XGS Monitoring Agent installer/);
  assert.match(help.stdout, /--enable-docker-watch/);
  assert.match(help.stdout, /one-use enrollment token/);
});

test("agent installer reports unhandled failures with line and exit status", () => {
  const installerSource = readFileSync(installerPath, "utf8");
  const failureHandler = installerSource.match(
    /report_unhandled_failure\(\) \{[\s\S]*?\n\}/,
  );
  assert.ok(failureHandler);

  const result = spawnSync(
    "bash",
    [
      "-c",
      [
        "set -Eeuo pipefail",
        failureHandler[0],
        "trap report_unhandled_failure ERR",
        "false",
      ].join("\n"),
    ],
    { encoding: "utf8" },
  );

  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /XGS Monitoring Agent installer: failed at line \d+ \(exit status 1\)\./,
  );
});

test("ban installer migrates to Fail2ban/UFW with explicit confirmation", () => {
  assert.doesNotThrow(() => accessSync(banInstallerPath, constants.X_OK));
  const source = readFileSync(banInstallerPath, "utf8");
  assert.match(
    source,
    /apt-get install -y --no-install-recommends fail2ban/,
  );
  assert.match(
    source,
    /ExecStartPost=\/usr\/bin\/timeout 10 \/bin\/sh -c .*while \[ ! -S \/run\/fail2ban\/fail2ban\.sock \].*chmod 0660 \/run\/fail2ban\/fail2ban\.sock/,
  );
  assert.match(source, /ufw app info "\$UFW_PROFILE"/);
  assert.match(source, /systemctl start "\$SERVICE_NAME"/);
  assert.match(source, /nft delete table inet xgs_monitor_agent/);
  assert.ok(
    source.indexOf('systemctl start "$SERVICE_NAME"') <
      source.indexOf("nft delete table inet xgs_monitor_agent"),
  );
  assert.doesNotMatch(source, /systemctl (?:enable|start) ufw\.service/);
  assert.doesNotMatch(source, /apt-get install[^'\n]*nftables/);

  const syntaxCheck = spawnSync("bash", ["-n", banInstallerPath], {
    encoding: "utf8",
  });
  assert.equal(syntaxCheck.status, 0, syntaxCheck.stderr);

  const help = spawnSync(banInstallerPath, ["--help"], { encoding: "utf8" });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /sudo \.\/install-ban-sync\.sh/);
  assert.match(help.stdout, /Central Discord autoban thresholds and allowlists remain unchanged/);
});

test("ban sync runs unprivileged and uses the Fail2ban control group", () => {
  const service = readFileSync(banServicePath, "utf8");
  assert.match(service, /^User=xgs-monitor-agent$/m);
  assert.match(service, /^Group=xgs-monitor-agent$/m);
  assert.match(service, /^SupplementaryGroups=xgs-monitor-agent-fail2ban$/m);
  assert.match(service, /^StateDirectory=xgs-monitor-agent$/m);
  assert.doesNotMatch(service, /^AmbientCapabilities=/m);
  assert.doesNotMatch(service, /^CapabilityBoundingSet=CAP_NET_ADMIN$/m);
});
