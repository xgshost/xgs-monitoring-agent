import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const helperPath = new URL("../apt-update.sh", import.meta.url);
const pbsEnterpriseUnauthorized = [
  "Hit:1 https://deb.debian.org/debian trixie InRelease",
  "Err:2 https://enterprise.proxmox.com/debian/pbs trixie InRelease",
  "  401 Unauthorized [IP: 192.0.2.1 443]",
  "E: Failed to fetch https://enterprise.proxmox.com/debian/pbs/dists/trixie/InRelease 401 Unauthorized [IP: 192.0.2.1 443]",
  "E: The repository 'https://enterprise.proxmox.com/debian/pbs trixie InRelease' is not signed.",
].join("\n");

function runAptUpdate(output, exitCode) {
  const directory = mkdtempSync(join(tmpdir(), "xgs-apt-update-test-"));
  const binDirectory = join(directory, "bin");
  const outputPath = join(directory, "apt-output");
  mkdirSync(binDirectory);
  writeFileSync(outputPath, output);
  writeFileSync(
    join(binDirectory, "apt-get"),
    '#!/bin/sh\ncat "$APT_UPDATE_TEST_OUTPUT"\nexit "$APT_UPDATE_TEST_EXIT_CODE"\n',
    { mode: 0o755 },
  );

  try {
    return spawnSync(
      "bash",
      ["-c", 'source "$1"; apt_update', "apt-update-test", helperPath.pathname],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          APT_UPDATE_TEST_OUTPUT: outputPath,
          APT_UPDATE_TEST_EXIT_CODE: String(exitCode),
          PATH: `${binDirectory}:${process.env.PATH}`,
        },
      },
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("APT update succeeds normally and preserves its output", () => {
  const result = runAptUpdate("Hit:1 https://deb.debian.org/debian trixie InRelease", 0);

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Hit:1/);
});

test("APT update tolerates only the unauthorized PBS Enterprise repository", () => {
  const result = runAptUpdate(pbsEnterpriseUnauthorized, 100);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /401 Unauthorized/);
  assert.match(result.stderr, /Repository configuration was not changed/);
});

test("APT update still fails when any other repository is unavailable", () => {
  const result = runAptUpdate(
    `${pbsEnterpriseUnauthorized}\nErr:3 https://deb.debian.org/debian trixie-updates InRelease\nE: Failed to fetch https://deb.debian.org/debian/dists/trixie-updates/InRelease Connection timed out`,
    100,
  );

  assert.equal(result.status, 100);
  assert.match(result.stderr, /Connection timed out/);
  assert.doesNotMatch(result.stderr, /Repository configuration was not changed/);
});
