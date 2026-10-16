import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { accessSync, constants, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const scriptPath = fileURLToPath(new URL("../reenroll.sh", import.meta.url));

test("re-enrollment script is executable, syntactically valid, and documented", () => {
  assert.doesNotThrow(() => accessSync(scriptPath, constants.X_OK));

  const syntaxCheck = spawnSync("bash", ["-n", scriptPath], {
    encoding: "utf8",
  });
  assert.equal(syntaxCheck.status, 0, syntaxCheck.stderr);

  const source = readFileSync(scriptPath, "utf8");
  assert.match(source, /read -r -s .*input hidden/);
  assert.match(source, /XGS_MONITOR_AGENT_STATE_FILE=/);
  assert.match(source, /credentials\.reenroll-/);
  assert.match(source, /chmod 0600/);
  assert.match(source, /state_is_enrolled/);
  assert.match(source, /remove_enrollment_token/);
  assert.doesNotMatch(source, /\/home\/anthony/);
  assert.doesNotMatch(source, /rm -f -- "\$0"/);

  const help = spawnSync(scriptPath, ["--help"], { encoding: "utf8" });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /sudo \.\/reenroll\.sh/);
  assert.match(help.stdout, /without echoing it/);
});
