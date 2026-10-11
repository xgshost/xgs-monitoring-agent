import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadAgentState, markAgentEnrolled } from "../dist/state.js";

test("agent credentials persist with owner-only permissions", () => {
  const directory = mkdtempSync(join(tmpdir(), "xgs-monitor-agent-state-"));
  const path = join(directory, "credentials.json");
  const enrollmentToken = "e".repeat(43);

  try {
    const pendingState = loadAgentState(path, enrollmentToken);
    assert.equal(pendingState.enrollmentAccepted, false);
    assert.equal(pendingState.enrollmentToken, enrollmentToken);
    assert.equal(statSync(path).mode & 0o777, 0o600);

    const enrolledState = markAgentEnrolled(path, pendingState);
    assert.equal(enrolledState.enrollmentAccepted, true);
    assert.equal(enrolledState.enrollmentToken, undefined);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(JSON.parse(readFileSync(path, "utf8")).enrollmentToken, undefined);

    const restoredState = loadAgentState(path);
    assert.equal(restoredState.agentToken, enrolledState.agentToken);
    assert.equal(restoredState.enrollmentAccepted, true);
    assert.equal(restoredState.enrollmentToken, undefined);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
