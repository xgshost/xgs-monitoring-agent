import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { dirname } from "node:path";
import type { AgentState } from "./state.js";

export const AGENT_ERROR_OPERATIONS = [
  "enrollment",
  "heartbeat_upload",
  "metrics_upload",
  "ssh_event_upload",
  "sudo_event_upload",
  "journal_reader",
  "agent_startup",
] as const;

export type AgentErrorOperation = (typeof AGENT_ERROR_OPERATIONS)[number];

export interface AgentErrorReport {
  operation: AgentErrorOperation;
  errorCode: string;
  occurredAtMs: number;
}

export const MAX_AGENT_ERROR_LOG_BYTES = 1_048_576;

const ERROR_REPORT_INTERVAL_MS = 60_000;
const lastForwardedAt = new Map<string, number>();
const errorCodePattern = /^[A-Za-z0-9_.-]{1,64}$/;

export function getAgentErrorCode(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "statusCode" in error &&
    typeof error.statusCode === "number" &&
    Number.isSafeInteger(error.statusCode)
  ) {
    return `HTTP_${error.statusCode}`;
  }

  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    errorCodePattern.test(error.code)
  ) {
    return error.code;
  }

  if (error instanceof Error && errorCodePattern.test(error.name)) {
    return error.name;
  }

  return "UNKNOWN";
}

export function appendAgentErrorLog(
  filePath: string,
  report: AgentErrorReport,
): void {
  if (
    !AGENT_ERROR_OPERATIONS.includes(report.operation) ||
    !errorCodePattern.test(report.errorCode) ||
    !Number.isSafeInteger(report.occurredAtMs) ||
    report.occurredAtMs < 1
  ) {
    throw new TypeError("Invalid agent error report");
  }

  const line = `${JSON.stringify(report)}\n`;
  const lineBytes = Buffer.byteLength(line, "utf8");
  if (lineBytes > MAX_AGENT_ERROR_LOG_BYTES) {
    throw new RangeError("Agent error log entry exceeds its size limit");
  }

  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  if (
    existsSync(filePath) &&
    statSync(filePath).size + lineBytes > MAX_AGENT_ERROR_LOG_BYTES
  ) {
    const rotatedPath = `${filePath}.1`;
    if (existsSync(rotatedPath)) {
      unlinkSync(rotatedPath);
    }
    renameSync(filePath, rotatedPath);
  }

  appendFileSync(filePath, line, { encoding: "utf8", mode: 0o600 });
  chmodSync(filePath, 0o600);
}

export async function reportAgentError(
  filePath: string,
  monitorBaseUrl: string,
  state: AgentState,
  operation: AgentErrorOperation,
  error: unknown,
  request: typeof fetch = fetch,
): Promise<void> {
  const report = {
    operation,
    errorCode: getAgentErrorCode(error),
    occurredAtMs: Date.now(),
  } satisfies AgentErrorReport;

  try {
    appendAgentErrorLog(filePath, report);
  } catch (writeError) {
    console.error(
      "Could not write local agent error log",
      getAgentErrorCode(writeError),
    );
  }

  if (!state.enrollmentAccepted) {
    return;
  }

  const now = report.occurredAtMs;
  const key = `${report.operation}:${report.errorCode}`;
  for (const [existingKey, forwardedAt] of lastForwardedAt) {
    if (now - forwardedAt >= ERROR_REPORT_INTERVAL_MS) {
      lastForwardedAt.delete(existingKey);
    }
  }
  const lastSentAt = lastForwardedAt.get(key);
  if (lastSentAt !== undefined && now - lastSentAt < ERROR_REPORT_INTERVAL_MS) {
    return;
  }
  lastForwardedAt.set(key, now);

  try {
    const response = await request(
      `${monitorBaseUrl}/api/v1/agents/errors`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${state.agentToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(report),
        signal: AbortSignal.timeout(3_000),
      },
    );
    if (!response.ok) {
      console.warn(
        "Central server did not accept agent error report",
        `HTTP_${response.status}`,
      );
    }
  } catch (reportError) {
    console.warn(
      "Could not forward agent error to central server",
      getAgentErrorCode(reportError),
    );
  }
}
