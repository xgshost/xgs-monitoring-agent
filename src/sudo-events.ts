export interface SudoAuthFailureEvent {
  username: string;
  occurredAt: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseSudoJournalEntry(
  line: string,
): SudoAuthFailureEvent | undefined {
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
    (record.SYSLOG_IDENTIFIER !== "sudo" && record._COMM !== "sudo") ||
    typeof record.MESSAGE !== "string" ||
    (typeof record.__REALTIME_TIMESTAMP !== "string" &&
      typeof record.__REALTIME_TIMESTAMP !== "number") ||
    !/pam_[a-z0-9_-]+\(sudo:auth\): authentication failure;/i.test(
      record.MESSAGE,
    )
  ) {
    return undefined;
  }

  const logname = /(?:^|\s)logname=([^\s;]*)/.exec(record.MESSAGE)?.[1];
  const uid = /(?:^|\s)uid=(\d+)(?:\s|;|$)/.exec(record.MESSAGE)?.[1];
  const username =
    logname && logname !== "-" ? logname : uid ? `uid:${uid}` : undefined;
  if (!username || username.length > 128) {
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
    username,
    occurredAt: Math.floor(timestampMicroseconds / 1000),
  };
}
