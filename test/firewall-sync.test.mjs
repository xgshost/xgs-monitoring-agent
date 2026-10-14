import assert from "node:assert/strict";
import test from "node:test";
import {
  buildNftablesSyncScript,
  firewallSyncErrorCode,
  parseSshPorts,
  syncNftablesPolicy,
  validateSshBanPolicy,
} from "../dist/firewall-sync.js";

const now = 1_800_000_000_000;

test("classifies nft failures without exposing stderr contents", () => {
  assert.equal(
    firewallSyncErrorCode(
      Object.assign(new Error("command failed"), {
        status: 1,
        stderr: "Operation not permitted for 203.0.113.7",
      }),
    ),
    "NFT_PERMISSION_DENIED",
  );
  assert.equal(
    firewallSyncErrorCode(
      Object.assign(new Error("command failed"), {
        status: 1,
        stderr: "syntax error, unexpected token",
      }),
    ),
    "NFT_SYNTAX_ERROR",
  );
  assert.equal(
    firewallSyncErrorCode(
      Object.assign(new Error("command failed"), {
        status: 2,
        stderr: "unclassified nft error",
      }),
    ),
    "NFT_EXIT_2_STDERR",
  );
  assert.equal(
    firewallSyncErrorCode(
      Object.assign(new Error("command failed"), {
        status: 1,
        stdout: "Operation not supported",
      }),
    ),
    "NFT_FEATURE_UNSUPPORTED",
  );
});

test("validates policy entries and rejects invalid or duplicate addresses", () => {
  assert.deepEqual(
    validateSshBanPolicy(
      {
        status: "ok",
        enabled: true,
        revision: 4,
        bans: [{ sourceIp: "192.0.2.10", expiresAtMs: now + 60_000 }],
      },
      now,
    ),
    {
      enabled: true,
      revision: 4,
      bans: [{ sourceIp: "192.0.2.10", expiresAtMs: now + 60_000 }],
    },
  );
  assert.throws(
    () =>
      validateSshBanPolicy(
        {
          status: "ok",
          enabled: true,
          revision: 4,
          bans: [
            { sourceIp: "192.0.2.10", expiresAtMs: now + 60_000 },
            { sourceIp: "192.0.2.10", expiresAtMs: now + 120_000 },
          ],
        },
        now,
      ),
    /duplicate/,
  );
  assert.throws(
    () =>
      validateSshBanPolicy(
        {
          status: "ok",
          enabled: true,
          revision: 4,
          bans: [
            {
              sourceIp: "192.0.2.10; flush ruleset",
              expiresAtMs: now + 60_000,
            },
          ],
        },
        now,
      ),
    /invalid IP/,
  );
  assert.throws(
      () =>
        validateSshBanPolicy(
          {
            status: "ok",
            enabled: true,
            revision: 4,
            bans: [{ sourceIp: "192.0.2.10", expiresAtMs: now + 2 * 86_400_000 }],
          },
          now,
        ),
      /invalid SSH ban/,
  );
});

test("validates per-host SSH ports and defaults to port 22", () => {
  assert.deepEqual(parseSshPorts(undefined), [22]);
  assert.deepEqual(parseSshPorts("2222,22"), [22, 2222]);
  assert.throws(() => parseSshPorts("22,22"), /unique/);
  assert.throws(() => parseSshPorts("22; flush ruleset"), /comma-separated/);
});

test("builds timed IPv4 and IPv6 set updates only for SSH ports", () => {
  const script = buildNftablesSyncScript(
    {
      enabled: true,
      revision: 1,
      bans: [
        { sourceIp: "192.0.2.10", expiresAtMs: now + 90_000 },
        { sourceIp: "2001:db8::1", expiresAtMs: now + 120_000 },
        { sourceIp: "192.0.2.20", expiresAtMs: now - 1 },
      ],
    },
    [22, 2222],
    now,
    false,
  );
  assert.match(script, /^add table inet xgs_monitor_agent$/m);
  assert.match(
    script,
    /tcp dport \{ 22, 2222 \} ip saddr @blocked_ipv4 drop/,
  );
  assert.doesNotMatch(script, /^flush |^delete table/m);
  assert.match(script, /192\.0\.2\.10 timeout 90s/);
  assert.match(script, /2001:db8::1 timeout 120s/);
  assert.doesNotMatch(script, /192\.0\.2\.20/);
  assert.doesNotMatch(script, /flush ruleset/);
});

test("disabling policy clears the dedicated table without adding bans", () => {
  const calls = [];
  const count = syncNftablesPolicy(
    {
      enabled: false,
      revision: 2,
      bans: [{ sourceIp: "192.0.2.10", expiresAtMs: now + 60_000 }],
    },
    [22],
    now,
    (args, input) => {
      calls.push({ args, input });
      return "table inet xgs_monitor_agent";
    },
  );
  assert.equal(count, 0);
  assert.equal(calls.length, 2);
  assert.match(
    calls[1].input,
    /^flush set inet xgs_monitor_agent blocked_ipv4/m,
  );
  assert.doesNotMatch(
    calls[1].input,
    /^flush table|^delete table|^add table|^add rule/m,
  );
  assert.doesNotMatch(calls[1].input, /add element/);
});

test("creates the table and first active ban in one nft transaction", () => {
  const calls = [];
  const count = syncNftablesPolicy(
    {
      enabled: true,
      revision: 3,
      bans: [{ sourceIp: "192.0.2.10", expiresAtMs: now + 60_000 }],
    },
    [22],
    now,
    (args, input) => {
      calls.push({ args, input });
      return "";
    },
  );
  assert.equal(count, 1);
  assert.equal(calls.length, 2);
  assert.match(calls[1].input, /^add table inet xgs_monitor_agent/m);
  assert.match(calls[1].input, /192\.0\.2\.10 timeout 60s/);
  assert.doesNotMatch(calls[1].input, /^delete table/m);
  assert.doesNotMatch(calls[1].input, /^flush /m);
});

test("atomically reconciles the existing table with the current policy", () => {
  const calls = [];
  const count = syncNftablesPolicy(
    {
      enabled: true,
      revision: 4,
      bans: [{ sourceIp: "192.0.2.10", expiresAtMs: now + 60_000 }],
    },
    [22],
    now,
    (args, input) => {
      calls.push({ args, input });
      return calls.length === 1 ? "table inet xgs_monitor_agent" : "";
    },
  );
  assert.equal(count, 1);
  assert.equal(calls.length, 2);
  assert.match(
    calls[1].input,
    /^flush set inet xgs_monitor_agent blocked_ipv4/m,
  );
  assert.match(calls[1].input, /192\.0\.2\.10 timeout 60s/);
  assert.doesNotMatch(
    calls[1].input,
    /^flush table|^delete table|^add table|^add rule/m,
  );
});

test("does not touch nftables when there is no table and no active ban", () => {
  const calls = [];
  assert.equal(
    syncNftablesPolicy(
      { enabled: false, revision: 1, bans: [] },
      [22],
      now,
      (args, input) => {
        calls.push({ args, input });
        return "";
      },
    ),
    0,
  );
  assert.equal(calls.length, 1);
});
