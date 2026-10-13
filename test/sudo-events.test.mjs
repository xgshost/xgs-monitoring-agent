import assert from "node:assert/strict";
import test from "node:test";
import { parseSudoJournalEntry } from "../dist/sudo-events.js";

test("parses sudo PAM failures into structured fields without raw journal data", () => {
  const event = parseSudoJournalEntry(
    JSON.stringify({
      SYSLOG_IDENTIFIER: "sudo",
      MESSAGE:
        "pam_unix(sudo:auth): authentication failure; logname=anthony uid=1000 euid=0 tty=/dev/pts/0 ruser= rhost= user=root COMMAND=/usr/bin/id",
      __REALTIME_TIMESTAMP: "1760200000123456",
    }),
  );

  assert.deepEqual(event, {
    username: "anthony",
    occurredAt: 1760200000123,
  });
  assert.equal(event && "rawMessage" in event, false);
  assert.equal(event && "command" in event, false);
});

test("uses the numeric UID when the sudo journal has no login name", () => {
  const event = parseSudoJournalEntry(
    JSON.stringify({
      _COMM: "sudo",
      MESSAGE:
        "pam_unix(sudo:auth): authentication failure; logname= uid=1000 euid=0 tty=pts/0 user=root",
      __REALTIME_TIMESTAMP: "1760200000123456",
    }),
  );

  assert.deepEqual(event, {
    username: "uid:1000",
    occurredAt: 1760200000123,
  });
});

test("ignores unrelated sudo records and matching messages from other services", () => {
  const base = {
    MESSAGE:
      "pam_unix(sudo:auth): authentication failure; logname=anthony uid=1000",
    __REALTIME_TIMESTAMP: "1760200000123456",
  };

  assert.equal(
    parseSudoJournalEntry(
      JSON.stringify({ ...base, SYSLOG_IDENTIFIER: "sudo", MESSAGE: "sudo command" }),
    ),
    undefined,
  );
  assert.equal(
    parseSudoJournalEntry(
      JSON.stringify({ ...base, SYSLOG_IDENTIFIER: "sshd" }),
    ),
    undefined,
  );
});
