import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { accessSync, constants, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const updaterPath = fileURLToPath(new URL("../update.sh", import.meta.url));
const migrationPath = fileURLToPath(
  new URL("../deploy/migrate-agent-v1-to-v2-host.sh", import.meta.url),
);
const agentBundlePath = fileURLToPath(
  new URL("../deploy/v2-agent-dist/index.js", import.meta.url),
);

test("updater is executable, syntactically valid, and checks before restarting", () => {
  assert.doesNotThrow(() => accessSync(updaterPath, constants.X_OK));

  const syntaxCheck = spawnSync("bash", ["-n", updaterPath], {
    encoding: "utf8",
  });
  assert.equal(syntaxCheck.status, 0, syntaxCheck.stderr);

  const source = readFileSync(updaterPath, "utf8");
  assert.match(
    source,
    /rebuild_current=false\s+disable_ban_sync=false\s+upgrade_to_v2=true/,
  );
  assert.match(source, /--rebuild-current/);
  assert.match(source, /--disable-ban-sync/);
  assert.match(source, /--upgrade-to-v2/);
  assert.match(source, /xgs-monitor-agent-v2\.migrated/);
  assert.match(source, /if \[\[ -f "\$V2_MIGRATION_MARKER" \]\]; then/);
  assert.match(source, /migrate-agent-v1-to-v2-host\.sh/);
  assert.match(source, /V2_AGENT_DIST_DIR="\$\{REPOSITORY_DIR\}\/deploy\/v2-agent-dist"/);
  assert.match(source, /V2_RELEASE_VERSION="2\.0\.0"/);
  assert.doesNotMatch(source, /\/containers\/XGS CONTROL V2\.0/);
  assert.match(source, /--remove-v1-after-install/);
  assert.match(source, /systemd-run/);
  assert.match(source, /--property=ProtectSystem=full/);
  assert.match(source, /XGS_MONITOR_AGENT_UPDATE_LOCK_HELD:-/);
  assert.match(source, /XGS_MONITOR_AGENT_UPDATE_LOCK_HELD=1/);
  assert.match(source, /xgs-monitor-agent-ban-sync\.disabled/);
  assert.match(source, /install-ban-sync\.sh" --remove/);
  assert.match(source, /git -C "\$REPOSITORY_DIR" fetch origin main/);
  assert.match(source, /git -C "\$REPOSITORY_DIR" merge --ff-only/);
  assert.match(source, /xgs-monitor-agent-successful-update/);
  assert.match(source, /flock -n 9/);
  assert.match(source, /X   X   GGGGG   SSSSS/);
  assert.match(source, /printf '  %s: '/);
  assert.match(source, /printf 'OK\\n'/);
  assert.match(source, /source "\$SCRIPT_DIR\/update-sudoers\.sh"/);
  assert.match(source, /ensure_update_sudoers_rule/);
  assert.ok(
    source.indexOf("ensure_update_sudoers_rule") <
      source.indexOf('if [[ "$current_commit" == "$available_commit"'),
  );
  const upToDateCheck = source.indexOf(
    'if [[ "$current_commit" == "$available_commit"',
  );
  const upToDateExit = source.indexOf("Already up to date", upToDateCheck);
  const reconcileBeforeUpToDateExit = source.indexOf(
    "update_ban_sync_if_ufw_active",
    upToDateCheck,
  );
  assert.ok(reconcileBeforeUpToDateExit > upToDateCheck);
  assert.ok(reconcileBeforeUpToDateExit < upToDateExit);
  assert.match(source, /run_step\(\)/);
  assert.match(source, /cat "\$output_log" >&2/);
  assert.match(source, /update_ban_sync_if_ufw_active\(\)/);
  assert.match(source, /"\$REPOSITORY_DIR\/install-ban-sync\.sh" --yes/);
  assert.match(source, /ufw status 2>&1/);
  assert.match(source, /Status: active/);
  const banSyncCall = source.indexOf("\nupdate_ban_sync_if_ufw_active\n");
  const serviceRestart = source.indexOf('run_step "Restarting service"');
  assert.ok(banSyncCall > source.indexOf('run_step "Preparing production files"'));
  assert.ok(banSyncCall < serviceRestart);
  assert.ok(
    source.indexOf("npm test") <
      source.indexOf('systemctl restart "$SERVICE_NAME"'),
  );
  assert.match(
    source,
    /if \[\[ "\$current_commit" != "\$available_commit" \]\]; then[\s\S]*XGS_MONITOR_AGENT_UPDATE_LOCK_HELD=1/,
  );
  assert.match(source, /git -C "\$REPOSITORY_DIR" status --porcelain/);
  const migrationCall = source.indexOf('run_step "Migrating V1 agent to V2"');
  assert.ok(migrationCall > source.indexOf('run_step "Applying update"'));
  assert.ok(migrationCall < source.indexOf('run_step "Installing dependencies"'));
  assert.match(source, /XGS_MONITOR_AGENT_UPDATE_LOCK_HELD=1/);
});

test("V2 migration assets are repository-local and gate V1 removal", () => {
  assert.doesNotThrow(() => accessSync(migrationPath, constants.X_OK));
  assert.doesNotThrow(() => accessSync(agentBundlePath, constants.R_OK));

  const syntaxCheck = spawnSync("bash", ["-n", migrationPath], {
    encoding: "utf8",
  });
  assert.equal(syntaxCheck.status, 0, syntaxCheck.stderr);

  const source = readFileSync(migrationPath, "utf8");
  assert.match(source, /--remove-v1-after-install/);
  assert.ok(
    source.lastIndexOf("check_local_v2") <
      source.lastIndexOf("remove_v1_installation"),
  );
  assert.match(source, /verify_v2_after_v1_removal/);
  assert.match(source, /assert_no_v1_firewall_sync/);
  assert.match(source, /xgs-monitor-agent-firewall-sync\.service/);
  assert.match(source, /xgs-monitor-agent-firewall-sync\.timer/);
});
