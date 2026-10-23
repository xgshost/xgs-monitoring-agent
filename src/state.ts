import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

const tokenPattern = /^[A-Za-z0-9_-]{43}$/;

export interface AgentState {
  agentToken: string;
  enrollmentToken?: string;
  enrollmentAccepted: boolean;
  debugEnabled?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseState(value: unknown): AgentState {
  if (
    !isRecord(value) ||
    typeof value.agentToken !== "string" ||
    !tokenPattern.test(value.agentToken) ||
    typeof value.enrollmentAccepted !== "boolean"
  ) {
    throw new Error("Agent state file has an invalid format");
  }

  const enrollmentToken = value.enrollmentToken;
  if (
    enrollmentToken !== undefined &&
    (typeof enrollmentToken !== "string" || !tokenPattern.test(enrollmentToken))
  ) {
    throw new Error("Agent state file has an invalid enrollment token");
  }

  if (!value.enrollmentAccepted && typeof enrollmentToken !== "string") {
    throw new Error("Pending agent state is missing its enrollment token");
  }

  const state: AgentState = {
    agentToken: value.agentToken,
    enrollmentAccepted: value.enrollmentAccepted,
  };
  if (typeof enrollmentToken === "string") {
    state.enrollmentToken = enrollmentToken;
  }
  return state;
}

export function loadAgentState(
  filePath: string,
  enrollmentToken?: string,
): AgentState {
  if (existsSync(filePath)) {
    chmodSync(filePath, 0o600);
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
    } catch {
      throw new Error("Agent state file is not valid JSON");
    }
    return parseState(parsed);
  }

  if (!enrollmentToken) {
    throw new Error(
      "No agent state exists; provide a fresh enrollment token to bootstrap",
    );
  }

  const state: AgentState = {
    agentToken: randomBytes(32).toString("base64url"),
    enrollmentToken,
    enrollmentAccepted: false,
  };
  saveAgentState(filePath, state);
  return state;
}

export function saveAgentState(filePath: string, state: AgentState): void {
  process.umask(0o077);
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.tmp`;
  writeFileSync(temporaryPath, JSON.stringify(state), { mode: 0o600 });
  chmodSync(temporaryPath, 0o600);
  renameSync(temporaryPath, filePath);
  chmodSync(filePath, 0o600);
}

export function markAgentEnrolled(filePath: string, state: AgentState): AgentState {
  const enrolledState: AgentState = {
    agentToken: state.agentToken,
    enrollmentAccepted: true,
  };
  saveAgentState(filePath, enrolledState);
  return enrolledState;
}
