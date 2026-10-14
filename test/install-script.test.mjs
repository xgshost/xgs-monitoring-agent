import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { accessSync, constants, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const installerPath = fileURLToPath(new URL("../install.sh", import.meta.url));
const firewallInstallerPath = fileURLToPath(
  new URL("../install-firewall-sync.sh", import.meta.url),
);
const firewallServicePath = fileURLToPath(
  new URL(
    "../deploy/systemd/xgs-monitor-agent-firewall-sync.service",
    import.meta.url,
  ),
);

test("installer is executable, syntactically valid, and documents its usage", () => {
  assert.doesNotThrow(() => accessSync(installerPath, constants.X_OK));
  assert.ok(
    readFileSync(installerPath, "utf8").includes(
      'chmod -R u=rwX,go=rX "$SCRIPT_DIR/dist"',
    ),
  );
  const installerSource = readFileSync(installerPath, "utf8");
  assert.match(installerSource, /^  update\.sh \\$/m);
  assert.match(installerSource, /^  auto-update\.sh \\$/m);
  assert.match(installerSource, /^  deploy \\$/m);

  const syntaxCheck = spawnSync("bash", ["-n", installerPath], {
    encoding: "utf8",
  });

  test("firewall sync installer is executable, valid, and requires explicit consent", () => {
    assert.doesNotThrow(() =>
      accessSync(firewallInstallerPath, constants.X_OK),
    );
    const firewallInstallerSource = readFileSync(firewallInstallerPath, "utf8");
    assert.match(
      firewallInstallerSource,
      /apt-get install -y --no-install-recommends nftables/,
    );
    assert.doesNotMatch(
      firewallInstallerSource,
      /systemctl (?:enable|start) nftables\.service/,
    );
    const syntaxCheck = spawnSync("bash", ["-n", firewallInstallerPath], {
      encoding: "utf8",
    });
    assert.equal(syntaxCheck.status, 0, syntaxCheck.stderr);
    const help = spawnSync(firewallInstallerPath, ["--help"], {
      encoding: "utf8",
    });
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /sudo \.\/install-firewall-sync\.sh/);
    assert.match(help.stdout, /Autobans remain disabled centrally/);
  });
  assert.equal(syntaxCheck.status, 0, syntaxCheck.stderr);

  const help = spawnSync(installerPath, ["--help"], {
    encoding: "utf8",
  });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /sudo \.\/install\.sh/);
  assert.match(help.stdout, /one-use enrollment token/);
});

test("firewall sync service is unprivileged except for nftables administration", () => {
  const service = readFileSync(firewallServicePath, "utf8");
  assert.match(service, /^User=xgs-monitor-agent$/m);
  assert.match(service, /^Group=xgs-monitor-agent$/m);
  assert.match(service, /^StateDirectory=xgs-monitor-agent$/m);
  assert.match(service, /^CapabilityBoundingSet=CAP_NET_ADMIN$/m);
  assert.match(service, /^AmbientCapabilities=CAP_NET_ADMIN$/m);
});
