import assert from "node:assert/strict";
import test from "node:test";
import { validateSshBanPolicy } from "../dist/firewall-sync.js";

test("SSH firewall policy carries the optional per-server debug setting", () => {
  const policy = validateSshBanPolicy({
    status: "ok",
    enabled: true,
    revision: 1,
    bans: [],
    debugEnabled: true,
  });
  assert.equal(policy.debugEnabled, true);

  const legacyPolicy = validateSshBanPolicy({
    status: "ok",
    enabled: true,
    revision: 1,
    bans: [],
  });
  assert.equal(legacyPolicy.debugEnabled, undefined);
});
