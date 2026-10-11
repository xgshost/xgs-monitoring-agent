import { isIP } from "node:net";

export interface SshAuthEvent {
  outcome: "success" | "failure";
  username: string;
  sourceIp: string;
  occurredAt: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseSshJournalEntry(line: string): SshAuthEvent | undefined {
  if (Buffer.byteLength(line, "utf8") > 8192) {
    return undefined;
  }

  let record: unknown;
  try {
    record = JSON.parse(line) as unknown;
  } catch {
    return undefined;
  }

  if (
    !isRecord(record) ||
    typeof record.MESSAGE !== "string" ||
    (typeof record.__REALTIME_TIMESTAMP !== "string" &&
      typeof record.__REALTIME_TIMESTAMP !== "number")
  ) {
    return undefined;
  }

  const match =
    /^(Accepted|Failed)\s+(?:password|publickey|keyboard-interactive(?:\/pam)?)\s+for\s+(?:invalid user\s+)?(\S+)\s+from\s+(\S+)\s+port\s+\d+(?:\s|$)/.exec(
      record.MESSAGE,
    );

  if (!match || match[2].length > 128 || isIP(match[3]) === 0) {
    return undefined;
  }

  const timestampMicroseconds = Number(record.__REALTIME_TIMESTAMP);
  if (
    !Number.isSafeInteger(timestampMicroseconds) ||
    timestampMicroseconds < 1
  ) {
    return undefined;
  }

  return {
    outcome: match[1] === "Accepted" ? "success" : "failure",
    username: match[2],
    sourceIp: match[3],
    occurredAt: Math.floor(timestampMicroseconds / 1000),
  };
}
