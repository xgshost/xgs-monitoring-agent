import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { accessSync, constants, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const updaterPath = fileURLToPath(new URL("../update.sh", import.meta.url));

test("updater is executable, syntactically valid, and checks before restarting", () => {
  assert.doesNotThrow(() => accessSync(updaterPath, constants.X_OK));

  const syntaxCheck = spawnSync("bash", ["-n", updaterPath], {
    encoding: "utf8",
  });
  assert.equal(syntaxCheck.status, 0, syntaxCheck.stderr);

  const source = readFileSync(updaterPath, "utf8");
  assert.match(source, /--rebuild-current/);
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
  assert.match(source, /run_step\(\)/);
  assert.match(source, /cat "\$output_log" >&2/);
  assert.ok(
    source.indexOf("npm test") <
      source.indexOf('systemctl restart "$SERVICE_NAME"'),
  );
  assert.match(source, /git -C "\$REPOSITORY_DIR" status --porcelain/);
});
