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
  assert.match(source, /git -C "\$REPOSITORY_DIR" pull --ff-only origin main/);
  assert.ok(
    source.indexOf("npm test") <
      source.indexOf('systemctl restart "$SERVICE_NAME"'),
  );
  assert.match(source, /git -C "\$REPOSITORY_DIR" status --porcelain/);
});
