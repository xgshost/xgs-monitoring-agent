import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { setTimeout as setTimer } from "node:timers";
import { loadAgentConfig } from "./config.js";
import {
  loadAgentState,
  markAgentEnrolled,
  type AgentState,
} from "./state.js";
import { parseSshJournalEntry } from "./ssh-events.js";

const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RETRY_DELAY_MS = 300_000;

class ReceiverResponseError extends Error {
  constructor(readonly statusCode: number) {
    super(`Receiver returned HTTP ${statusCode}`);
  }
}

function isPermanentClientError(error: unknown): boolean {
  return (
    error instanceof ReceiverResponseError &&
    error.statusCode >= 400 &&
    error.statusCode < 500 &&
    error.statusCode !== 408 &&
    error.statusCode !== 429
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readHeartbeatInterval(value: unknown): number {
  if (
    !isObject(value) ||
    typeof value.heartbeatIntervalSeconds !== "number" ||
    !Number.isSafeInteger(value.heartbeatIntervalSeconds) ||
    value.heartbeatIntervalSeconds < 1
  ) {
    throw new Error("Receiver returned an invalid heartbeat interval");
  }

  return value.heartbeatIntervalSeconds;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : "Unexpected receiver error";
}

let stopping = false;
let journalProcess: ReturnType<typeof spawn> | undefined;
const waiters = new Set<() => void>();

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    let timer: NodeJS.Timeout;
    const wake = () => {
      clearTimeout(timer);
      waiters.delete(wake);
      resolve();
    };
    timer = setTimer(() => {
      waiters.delete(wake);
      resolve();
    }, milliseconds);
    waiters.add(wake);
  });
}

function stop(): void {
  stopping = true;
  for (const wake of waiters) {
    wake();
  }
  journalProcess?.kill("SIGTERM");
}

process.once("SIGINT", stop);
process.once("SIGTERM", stop);

async function redeemEnrollment(
  state: AgentState,
  config: ReturnType<typeof loadAgentConfig>,
): Promise<{ state: AgentState; heartbeatIntervalSeconds: number }> {
  if (!state.enrollmentToken) {
    throw new Error("Pending agent state has no enrollment token");
  }

  const response = await fetch(
    `${config.monitorBaseUrl}/api/v1/agents/enroll`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        enrollmentToken: state.enrollmentToken,
        agentToken: state.agentToken,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    },
  );

  if (!response.ok) {
    throw new ReceiverResponseError(response.status);
  }

  const responseBody: unknown = await response.json();
  if (!isObject(responseBody) || responseBody.status !== "enrolled") {
    throw new Error("Receiver returned an invalid enrollment response");
  }

  return {
    state: markAgentEnrolled(config.stateFilePath, state),
    heartbeatIntervalSeconds: readHeartbeatInterval(responseBody),
  };
}

async function redeemWithRetry(
  initialState: AgentState,
  config: ReturnType<typeof loadAgentConfig>,
): Promise<{ state: AgentState; heartbeatIntervalSeconds: number } | undefined> {
  let retryDelay = 1_000;

  while (!stopping) {
    try {
      return await redeemEnrollment(initialState, config);
    } catch (error) {
      if (isPermanentClientError(error)) {
        throw new Error(
          "Enrollment was rejected or expired. Clear the agent state file and request a fresh enrollment token.",
        );
      }

      if (stopping) {
        return undefined;
      }

      console.error("Enrollment request failed; retrying", describeError(error));
      await wait(retryDelay);
      retryDelay = Math.min(retryDelay * 2, 60_000);
    }
  }

  return undefined;
}

async function sendHeartbeat(
  state: AgentState,
  config: ReturnType<typeof loadAgentConfig>,
): Promise<number> {
  const response = await fetch(
    `${config.monitorBaseUrl}/api/v1/agents/heartbeat`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${state.agentToken}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    },
  );

  if (!response.ok) {
    throw new ReceiverResponseError(response.status);
  }

  return readHeartbeatInterval(await response.json());
}

async function sendSshEvent(
  event: NonNullable<ReturnType<typeof parseSshJournalEntry>>,
  state: AgentState,
  config: ReturnType<typeof loadAgentConfig>,
): Promise<void> {
  const response = await fetch(
    `${config.monitorBaseUrl}/api/v1/agents/ssh-events`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${state.agentToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    },
  );

  if (!response.ok) {
    throw new ReceiverResponseError(response.status);
  }
}

async function sendSshEventWithRetry(
  event: NonNullable<ReturnType<typeof parseSshJournalEntry>>,
  state: AgentState,
  config: ReturnType<typeof loadAgentConfig>,
): Promise<void> {
  let retryDelay = 1_000;

  while (!stopping) {
    try {
      await sendSshEvent(event, state, config);
      return;
    } catch (error) {
      if (isPermanentClientError(error)) {
        throw error;
      }

      if (stopping) {
        return;
      }

      console.error("SSH event upload failed; retrying", describeError(error));
      await wait(retryDelay);
      retryDelay = Math.min(retryDelay * 2, MAX_RETRY_DELAY_MS);
    }
  }
}

async function followSshJournal(
  state: AgentState,
  config: ReturnType<typeof loadAgentConfig>,
): Promise<void> {
  const child = spawn(
    "journalctl",
    [
      "--follow",
      "--lines=0",
      "--output=json",
      "--no-pager",
      "--identifier=sshd",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  journalProcess = child;

  let permissionDenied = false;
  let spawnFailure: unknown;
  child.on("error", (error) => {
    spawnFailure = error;
  });
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    if (/permission denied|insufficient permissions/i.test(chunk)) {
      permissionDenied = true;
    }
  });

  const closed = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve) => {
    child.once("close", (code, signal) => {
      if (journalProcess === child) {
        journalProcess = undefined;
      }
      resolve({ code, signal });
    });
  });

  if (!child.stdout) {
    child.kill("SIGTERM");
    throw new Error("journalctl stdout is unavailable");
  }

  const lines = createInterface({ input: child.stdout });
  try {
    for await (const line of lines) {
      if (stopping) {
        break;
      }

      const event = parseSshJournalEntry(line);
      if (event) {
        await sendSshEventWithRetry(event, state, config);
      }
    }
  } finally {
    lines.close();
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
    }
  }

  const exit = await closed;
  if (journalProcess === child) {
    journalProcess = undefined;
  }

  if (stopping) {
    return;
  }
  if (spawnFailure) {
    throw new Error("Unable to start journalctl; verify it is installed");
  }
  if (permissionDenied) {
    throw new Error(
      "Agent cannot read the systemd journal. It remains non-root; journal-read access must be approved and configured by an administrator.",
    );
  }
  throw new Error(`journalctl exited with code ${exit.code ?? "unknown"}`);
}

async function runSshJournalReader(
  state: AgentState,
  config: ReturnType<typeof loadAgentConfig>,
): Promise<void> {
  while (!stopping) {
    try {
      await followSshJournal(state, config);
    } catch (error) {
      if (stopping) {
        return;
      }
      console.error("SSH journal reader stopped; retrying", describeError(error));
      await wait(30_000);
    }
  }
}

async function runHeartbeats(
  state: AgentState,
  config: ReturnType<typeof loadAgentConfig>,
  initialIntervalSeconds: number,
): Promise<void> {
  let heartbeatIntervalSeconds = initialIntervalSeconds;
  let retryDelay = heartbeatIntervalSeconds * 1000;

  while (!stopping) {
    try {
      heartbeatIntervalSeconds = await sendHeartbeat(state, config);
      retryDelay = heartbeatIntervalSeconds * 1000;
      await wait(retryDelay);
    } catch (error) {
      if (isPermanentClientError(error)) {
        throw new Error(
          "Receiver rejected the agent credential. Clear the agent state file and enroll the server again.",
        );
      }

      if (stopping) {
        return;
      }

      console.error("Heartbeat failed; retrying", describeError(error));
      await wait(retryDelay);
      retryDelay = Math.min(retryDelay * 2, MAX_RETRY_DELAY_MS);
    }
  }
}

async function main(): Promise<void> {
  process.umask(0o077);
  const config = loadAgentConfig(process.env);
  let state = loadAgentState(config.stateFilePath, config.enrollmentToken);
  let heartbeatIntervalSeconds = config.heartbeatIntervalSeconds;

  if (!state.enrollmentAccepted) {
    const redemption = await redeemWithRetry(state, config);
    if (!redemption) {
      return;
    }
    state = redemption.state;
    heartbeatIntervalSeconds = redemption.heartbeatIntervalSeconds;
    console.info("Agent enrollment completed");
  }

  console.info("Agent heartbeat service started");
  await Promise.all([
    runHeartbeats(state, config, heartbeatIntervalSeconds),
    runSshJournalReader(state, config),
  ]);
}

void main().catch((error: unknown) => {
  stop();
  console.error(
    "Agent stopped",
    error instanceof Error ? error.message : "Unexpected error",
  );
  process.exitCode = 1;
});
