import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { accessSync, constants, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const agentDirectory = fileURLToPath(new URL("..", import.meta.url));
const autoUpdatePath = fileURLToPath(
  new URL("../auto-update.sh", import.meta.url),
);

test("automatic updates are opt-in and use a daily systemd timer", () => {
  assert.doesNotThrow(() => accessSync(autoUpdatePath, constants.X_OK));
  const syntaxCheck = spawnSync("bash", ["-n", autoUpdatePath], {
    encoding: "utf8",
  });
  assert.equal(syntaxCheck.status, 0, syntaxCheck.stderr);

  const timer = readFileSync(
    `${agentDirectory}/deploy/systemd/xgs-monitor-agent-update.timer`,
    "utf8",
  );
  const service = readFileSync(
    `${agentDirectory}/deploy/systemd/xgs-monitor-agent-update.service`,
    "utf8",
  );
  const updater = readFileSync(autoUpdatePath, "utf8");
  assert.match(timer, /^OnCalendar=daily$/m);
  assert.match(timer, /^RandomizedDelaySec=30m$/m);
  assert.match(service, /^ExecStart=\/opt\/xgs-monitoring-agent\/update\.sh$/m);
  assert.match(updater, /X   X   GGGGG   SSSSS/);
  assert.match(updater, /systemctl enable --now "\$TIMER_UNIT"/);
  assert.match(updater, /systemctl disable --now "\$TIMER_UNIT"/);
});
