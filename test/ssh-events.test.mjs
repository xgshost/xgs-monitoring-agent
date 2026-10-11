import assert from "node:assert/strict";
import test from "node:test";
import { parseSshJournalEntry } from "../dist/ssh-events.js";

test("parses successful SSH authentication into structured fields only", () => {
  const event = parseSshJournalEntry(
    JSON.stringify({
      MESSAGE: "Accepted publickey for anthony from 192.0.2.10 port 54321 ssh2",
      __REALTIME_TIMESTAMP: "1760200000123456",
    }),
  );

  assert.deepEqual(event, {
    outcome: "success",
    username: "anthony",
    sourceIp: "192.0.2.10",
    occurredAt: 1760200000123,
  });
  assert.equal(event && "rawMessage" in event, false);
});

test("parses failed SSH authentication and ignores unrelated log entries", () => {
  const event = parseSshJournalEntry(
    JSON.stringify({
      MESSAGE:
        "Failed password for invalid user attacker from 2001:db8::1 port 2222 ssh2",
      __REALTIME_TIMESTAMP: "1760200000123456",
    }),
  );

  assert.deepEqual(event, {
    outcome: "failure",
    username: "attacker",
    sourceIp: "2001:db8::1",
    occurredAt: 1760200000123,
  });
  assert.equal(
    parseSshJournalEntry(
      JSON.stringify({
        MESSAGE: "Connection closed by authenticating user anthony 192.0.2.10",
        __REALTIME_TIMESTAMP: "1760200000123456",
      }),
    ),
    undefined,
  );
});
