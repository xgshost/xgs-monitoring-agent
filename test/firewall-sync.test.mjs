import assert from "node:assert/strict";
import test from "node:test";
import {
  firewallSyncErrorCode,
  parseFail2banBanList,
  parseSshPorts,
  syncFail2banPolicy,
  validateSshBanPolicy,
} from "../dist/firewall-sync.js";

const now = 1_800_000_000_000;

test("classifies Fail2ban failures without exposing output", () => {
  assert.equal(
    firewallSyncErrorCode(
      Object.assign(new Error("command failed"), {
        status: 1,
        stderr: "Permission denied for 203.0.113.7",
      }),
    ),
    "FAIL2BAN_PERMISSION_DENIED",
  );
  assert.equal(
    firewallSyncErrorCode(
      Object.assign(new Error("command failed"), {
        status: 1,
        stderr: "Jail xgs-monitor-agent not found",
      }),
    ),
    "FAIL2BAN_JAIL_MISSING",
  );
  assert.equal(
    firewallSyncErrorCode(
      Object.assign(new Error("command failed"), {
        status: 2,
        stderr: "unclassified Fail2ban error",
      }),
    ),
    "FAIL2BAN_EXIT_2_OUTPUT",
  );
  assert.equal(
    firewallSyncErrorCode(
      Object.assign(new Error("request failed"), { statusCode: 503 }),
    ),
    "HTTP_503",
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

test("parses Fail2ban's empty and populated ban lists", () => {
  assert.deepEqual(parseFail2banBanList(""), []);
  assert.deepEqual(
    parseFail2banBanList("192.0.2.10, 2001:db8::1\n"),
    ["192.0.2.10", "2001:db8::1"],
  );
  assert.throws(() => parseFail2banBanList("not-an-ip"), /invalid IP/);
});

test("validates per-host SSH ports and defaults to port 22", () => {
  assert.deepEqual(parseSshPorts(undefined), [22]);
  assert.deepEqual(parseSshPorts("2222,22"), [22, 2222]);
  assert.throws(() => parseSshPorts("22,22"), /unique/);
  assert.throws(() => parseSshPorts("22; ufw reset"), /comma-separated/);
});

test("reconciles Fail2ban bans to the current central policy", () => {
  const calls = [];
  const count = syncFail2banPolicy(
    {
      enabled: true,
      revision: 4,
      bans: [
        { sourceIp: "192.0.2.11", expiresAtMs: now + 60_000 },
        { sourceIp: "192.0.2.12", expiresAtMs: now - 1 },
      ],
    },
    [22],
    now,
    (args) => {
      calls.push(args);
      return calls.length === 1
        ? "192.0.2.10, 192.0.2.11"
        : "";
    },
  );

  assert.equal(count, 1);
  assert.deepEqual(calls, [
    ["get", "xgs-monitor-agent", "banip", ","],
    ["set", "xgs-monitor-agent", "unbanip", "192.0.2.10"],
  ]);
});

test("adds policy bans absent from the dedicated Fail2ban jail", () => {
  const calls = [];
  const count = syncFail2banPolicy(
    {
      enabled: true,
      revision: 5,
      bans: [
        { sourceIp: "192.0.2.10", expiresAtMs: now + 60_000 },
        { sourceIp: "2001:db8::1", expiresAtMs: now + 60_000 },
      ],
    },
    [22],
    now,
    (args) => {
      calls.push(args);
      return "";
    },
  );

  assert.equal(count, 2);
  assert.deepEqual(calls, [
    ["get", "xgs-monitor-agent", "banip", ","],
    ["set", "xgs-monitor-agent", "banip", "192.0.2.10", "2001:db8::1"],
  ]);
});

test("clears the dedicated jail when central autobans are disabled", () => {
  const calls = [];
  assert.equal(
    syncFail2banPolicy(
      {
        enabled: false,
        revision: 6,
        bans: [{ sourceIp: "192.0.2.10", expiresAtMs: now + 60_000 }],
      },
      [22],
      now,
      (args) => {
        calls.push(args);
        return "192.0.2.10";
      },
    ),
    0,
  );
  assert.deepEqual(calls, [
    ["get", "xgs-monitor-agent", "banip", ","],
    ["set", "xgs-monitor-agent", "unbanip", "192.0.2.10"],
  ]);
});

test("batches large policy changes into bounded Fail2ban commands", () => {
  const calls = [];
  const bans = Array.from({ length: 201 }, (_, index) => ({
    sourceIp: `10.0.${Math.floor(index / 250)}.${(index % 250) + 1}`,
    expiresAtMs: now + 60_000,
  }));
  assert.equal(
    syncFail2banPolicy(
      { enabled: true, revision: 7, bans },
      [22],
      now,
      (args) => {
        calls.push(args);
        return "";
      },
    ),
    201,
  );
  assert.equal(calls.length, 4);
  assert.deepEqual(calls.map((args) => args.length), [4, 103, 103, 4]);
});
