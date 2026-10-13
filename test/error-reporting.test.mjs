import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  appendAgentErrorLog,
  MAX_AGENT_ERROR_LOG_BYTES,
  reportAgentError,
} from "../dist/error-reporting.js";

test("writes sanitized agent errors locally and forwards them to the receiver", async () => {
  const directory = mkdtempSync(join(tmpdir(), "xgs-monitor-agent-errors-"));
  const logPath = join(directory, "errors.jsonl");
  const token = "a".repeat(43);
  let requestUrl;
  let requestOptions;

  try {
    await reportAgentError(
      logPath,
      "https://monitor.example",
      { agentToken: token, enrollmentAccepted: true },
      "heartbeat_upload",
      Object.assign(new Error("do not forward this message"), {
        code: "ECONNREFUSED",
      }),
      async (url, options) => {
        requestUrl = url;
        requestOptions = options;
        return new Response(null, { status: 202 });
      },
    );

    const record = JSON.parse(readFileSync(logPath, "utf8"));
    assert.equal(record.operation, "heartbeat_upload");
    assert.equal(record.errorCode, "ECONNREFUSED");
    assert.equal(typeof record.occurredAtMs, "number");
    assert.equal(statSync(logPath).mode & 0o777, 0o600);
    assert.equal(requestUrl, "https://monitor.example/api/v1/agents/errors");
    assert.equal(requestOptions.headers.authorization, `Bearer ${token}`);
    assert.equal(requestOptions.body.includes("do not forward"), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rotates the local error log at its configured size limit", () => {
  const directory = mkdtempSync(join(tmpdir(), "xgs-monitor-agent-errors-"));
  const logPath = join(directory, "errors.jsonl");

  try {
    writeFileSync(logPath, Buffer.alloc(MAX_AGENT_ERROR_LOG_BYTES, 120), {
      mode: 0o600,
    });
    appendAgentErrorLog(logPath, {
      operation: "journal_reader",
      errorCode: "EACCES",
      occurredAtMs: 1,
    });

    assert.equal(
      statSync(`${logPath}.1`).size,
      MAX_AGENT_ERROR_LOG_BYTES,
    );
    assert.ok(statSync(logPath).size < MAX_AGENT_ERROR_LOG_BYTES);
    assert.equal(statSync(logPath).mode & 0o777, 0o600);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
