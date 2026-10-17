import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const helperPath = fileURLToPath(
  new URL("../update-sudoers.sh", import.meta.url),
);
const helperSource = readFileSync(helperPath, "utf8");

test("sudoers helper scopes passwordless access to the invoking user and updater", () => {
  assert.match(helperSource, /\$\{SUDO_USER:-\}/);
  assert.match(
    helperSource,
    /NOPASSWD: \/opt\/xgs-monitoring-agent\/update\.sh/,
  );
  assert.ok(helperSource.includes('update.sh \\"\\"'));
  assert.match(helperSource, /grep -Fqx -- "\$rule" "\$sudoers_file"/);
  assert.match(helperSource, /visudo -cf/);
  assert.match(helperSource, /chmod 0440/);

  const syntaxCheck = spawnSync("bash", ["-n", helperPath], {
    encoding: "utf8",
  });
  assert.equal(syntaxCheck.status, 0, syntaxCheck.stderr);
});

test("sudoers helper skips direct root and systemd invocations", () => {
  const run = (sudoUser) =>
    spawnSync(
      "bash",
      [
        "-c",
        'source "$1"; ensure_update_sudoers_rule',
        "bash",
        helperPath,
      ],
      {
        encoding: "utf8",
        env: { ...process.env, SUDO_USER: sudoUser },
      },
    );

  const noCaller = run("");
  assert.equal(noCaller.status, 0, noCaller.stderr);
  assert.match(noCaller.stdout, /no non-root sudo caller; skipped/);

  const rootCaller = run("root");
  assert.equal(rootCaller.status, 0, rootCaller.stderr);
  assert.match(rootCaller.stdout, /no non-root sudo caller; skipped/);
});
