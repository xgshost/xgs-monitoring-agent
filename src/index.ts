import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as setTimer } from "node:timers";
import { loadAgentConfig } from "./config.js";
import {
  reportAgentError,
  type AgentErrorOperation,
} from "./error-reporting.js";
import {
  reportAgentDebug,
  summarizeAgentMetrics,
  type AgentDebugMetricsSummary,
  type AgentDebugOperation,
} from "./debug-reporting.js";
import {
  loadAgentState,
  markAgentEnrolled,
  type AgentState,
} from "./state.js";
import { collectAgentMetrics } from "./metrics.js";
import {
  collectDockerContainerSnapshots,
  collectDockerContainerNames,
  type DockerContainerSnapshot,
} from "./docker-watch.js";
import { parseSshJournalEntry } from "./ssh-events.js";
import { parseSudoJournalEntry } from "./sudo-events.js";

const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RETRY_DELAY_MS = 300_000;
const DOCKER_WATCH_PAGE_SIZE = 100;

class ReceiverResponseError extends Error {
  constructor(readonly statusCode: number) {
    super(`Receiver returned HTTP ${statusCode}`);
  }
}

function readDebugMode(value: unknown): boolean {
  if (!isObject(value)) {
    throw new Error("Receiver returned an invalid heartbeat response");
  }
  if (value.debugEnabled !== undefined && typeof value.debugEnabled !== "boolean") {
    throw new Error("Receiver returned an invalid debug mode");
  }
  return value.debugEnabled === true;
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

async function recordDebug(
  state: AgentState,
  config: ReturnType<typeof loadAgentConfig>,
  operation: AgentDebugOperation,
  metrics?: AgentDebugMetricsSummary,
): Promise<void> {
  await reportAgentDebug(
    join(dirname(config.stateFilePath), "errors.jsonl"),
    config.monitorBaseUrl,
    state,
    operation,
    undefined,
    metrics,
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

async function recordError(
  state: AgentState,
  config: ReturnType<typeof loadAgentConfig>,
  operation: AgentErrorOperation,
  message: string,
  error: unknown,
): Promise<void> {
  console.error(message, describeError(error));
  await reportAgentError(
    join(dirname(config.stateFilePath), "errors.jsonl"),
    config.monitorBaseUrl,
    state,
    operation,
    error,
  );
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
): Promise<{
  state: AgentState;
  heartbeatIntervalSeconds: number;
  debugEnabled: boolean;
}> {
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

  const enrolledState = markAgentEnrolled(config.stateFilePath, state);
  enrolledState.debugEnabled = readDebugMode(responseBody);
  return {
    state: enrolledState,
    heartbeatIntervalSeconds: readHeartbeatInterval(responseBody),
    debugEnabled: enrolledState.debugEnabled,
  };
}

async function redeemWithRetry(
  initialState: AgentState,
  config: ReturnType<typeof loadAgentConfig>,
): Promise<{
  state: AgentState;
  heartbeatIntervalSeconds: number;
  debugEnabled: boolean;
} | undefined> {
  let retryDelay = 1_000;

  while (!stopping) {
    try {
      return await redeemEnrollment(initialState, config);
    } catch (error) {
      if (isPermanentClientError(error)) {
        const rejection = new Error(
          "Enrollment was rejected or expired. Clear the agent state file and request a fresh enrollment token.",
        );
        await recordError(
          initialState,
          config,
          "enrollment",
          "Enrollment request rejected",
          rejection,
        );
        throw rejection;
      }

      if (stopping) {
        return undefined;
      }

      await recordError(
        initialState,
        config,
        "enrollment",
        "Enrollment request failed; retrying",
        error,
      );
      await wait(retryDelay);
      retryDelay = Math.min(retryDelay * 2, 60_000);
    }
  }

  return undefined;
}

async function sendHeartbeat(
  state: AgentState,
  config: ReturnType<typeof loadAgentConfig>,
): Promise<{ heartbeatIntervalSeconds: number; debugEnabled: boolean }> {
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

  const responseBody: unknown = await response.json();
  return {
    heartbeatIntervalSeconds: readHeartbeatInterval(responseBody),
    debugEnabled: readDebugMode(responseBody),
  };
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

async function sendSudoAuthFailureEvent(
  event: NonNullable<ReturnType<typeof parseSudoJournalEntry>>,
  state: AgentState,
  config: ReturnType<typeof loadAgentConfig>,
): Promise<void> {
  const response = await fetch(
    `${config.monitorBaseUrl}/api/v1/agents/sudo-events`,
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

async function sendMetrics(
  state: AgentState,
  config: ReturnType<typeof loadAgentConfig>,
): Promise<{
  heartbeatIntervalSeconds: number;
  debugMetrics: AgentDebugMetricsSummary;
}> {
  const metrics = await collectAgentMetrics(config.serviceUnits);
  const response = await fetch(
    `${config.monitorBaseUrl}/api/v1/agents/metrics`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${state.agentToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(metrics),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    },
  );

  if (!response.ok) {
    throw new ReceiverResponseError(response.status);
  }

  return {
    heartbeatIntervalSeconds: readHeartbeatInterval(
      await response.json(),
    ),
    debugMetrics: summarizeAgentMetrics(metrics),
  };
}

interface DockerWatchPolicyPage {
  restartThreshold: number;
  windowMinutes: number;
  containers: string[];
  nextOffset: number | null;
}

async function fetchDockerWatchPolicyPage(
  state: AgentState,
  config: ReturnType<typeof loadAgentConfig>,
  offset: number,
): Promise<DockerWatchPolicyPage> {
  const response = await fetch(
    `${config.monitorBaseUrl}/api/v1/agents/docker-watch-policy?offset=${offset}`,
    {
      headers: { authorization: `Bearer ${state.agentToken}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    },
  );
  if (!response.ok) {
    throw new ReceiverResponseError(response.status);
  }
  const body: unknown = await response.json();
  if (
    !isObject(body) ||
    body.status !== "ok" ||
    typeof body.restartThreshold !== "number" ||
    !Number.isSafeInteger(body.restartThreshold) ||
    body.restartThreshold < 2 ||
    body.restartThreshold > 100 ||
    typeof body.windowMinutes !== "number" ||
    !Number.isSafeInteger(body.windowMinutes) ||
    body.windowMinutes < 1 ||
    body.windowMinutes > 60 ||
    !Array.isArray(body.containers) ||
    body.containers.length > DOCKER_WATCH_PAGE_SIZE ||
    (body.nextOffset !== null &&
      (typeof body.nextOffset !== "number" ||
        !Number.isSafeInteger(body.nextOffset) ||
        body.nextOffset <= offset))
  ) {
    throw new Error("Receiver returned an invalid Docker watch policy");
  }
  const containers: string[] = [];
  for (const name of body.containers) {
    if (
      typeof name !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(name)
    ) {
      throw new Error("Receiver returned an invalid Docker watch container");
    }
    containers.push(name);
  }
  return {
    restartThreshold: body.restartThreshold,
    windowMinutes: body.windowMinutes,
    containers,
    nextOffset: body.nextOffset as number | null,
  };
}

async function fetchDockerWatchPolicy(
  state: AgentState,
  config: ReturnType<typeof loadAgentConfig>,
): Promise<string[]> {
  let offset = 0;
  let restartThreshold: number | undefined;
  let windowMinutes: number | undefined;
  const containers: string[] = [];
  const seen = new Set<string>();
  do {
    const page = await fetchDockerWatchPolicyPage(state, config, offset);
    if (
      (restartThreshold !== undefined &&
        restartThreshold !== page.restartThreshold) ||
      (windowMinutes !== undefined && windowMinutes !== page.windowMinutes)
    ) {
      throw new Error("Docker watch policy changed while loading pages");
    }
    restartThreshold = page.restartThreshold;
    windowMinutes = page.windowMinutes;
    for (const name of page.containers) {
      if (seen.has(name)) {
        throw new Error("Receiver returned duplicate Docker watch containers");
      }
      seen.add(name);
      containers.push(name);
    }
    if (page.nextOffset === null) {
      break;
    }
    offset = page.nextOffset;
  } while (!stopping);
  return containers;
}

async function sendDockerWatchReport(
  state: AgentState,
  config: ReturnType<typeof loadAgentConfig>,
  report:
    | { available: true; containers: DockerContainerSnapshot[] }
    | { available: false; errorCode: string; containers: [] },
): Promise<void> {
  const groups =
    report.containers.length === 0
      ? [[]]
      : Array.from(
          { length: Math.ceil(report.containers.length / DOCKER_WATCH_PAGE_SIZE) },
          (_, index) =>
            report.containers.slice(
              index * DOCKER_WATCH_PAGE_SIZE,
              (index + 1) * DOCKER_WATCH_PAGE_SIZE,
            ),
        );
  for (const containers of groups) {
    const body = report.available
      ? { available: true, containers }
      : {
          available: false,
          errorCode: report.errorCode,
          containers: [],
        };
    const response = await fetch(
      `${config.monitorBaseUrl}/api/v1/agents/docker-watch-status`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${state.agentToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
    );
    if (!response.ok) {
      throw new ReceiverResponseError(response.status);
    }
  }
}

async function sendDockerContainerInventory(
  state: AgentState,
  config: ReturnType<typeof loadAgentConfig>,
  inventory: Awaited<ReturnType<typeof collectDockerContainerNames>>,
): Promise<void> {
  const response = await fetch(
    `${config.monitorBaseUrl}/api/v1/agents/docker-container-inventory`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${state.agentToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(inventory),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    },
  );
  if (!response.ok) {
    throw new ReceiverResponseError(response.status);
  }
}

async function runDockerWatch(
  state: AgentState,
  config: ReturnType<typeof loadAgentConfig>,
  initialIntervalSeconds: number,
): Promise<void> {
  let intervalSeconds = initialIntervalSeconds;
  let retryDelay = intervalSeconds * 1000;

  while (!stopping) {
    try {
      const names = await fetchDockerWatchPolicy(state, config);
      await recordDebug(state, config, "docker_watch_policy_fetch");
      const report = await collectDockerContainerSnapshots(names);
      await sendDockerWatchReport(state, config, report);
      await recordDebug(state, config, "docker_watch_status_upload");
      const inventory = await collectDockerContainerNames();
      await sendDockerContainerInventory(state, config, inventory);
      await recordDebug(state, config, "docker_watch_inventory_upload");
      retryDelay = intervalSeconds * 1000;
      await wait(retryDelay);
    } catch (error) {
      if (stopping) {
        return;
      }
      await recordError(
        state,
        config,
        "docker_watch_upload",
        "Docker watch check failed; retrying",
        error,
      );
      await wait(retryDelay);
      retryDelay = Math.min(retryDelay * 2, MAX_RETRY_DELAY_MS);
    }
  }
}

async function runMetrics(
  state: AgentState,
  config: ReturnType<typeof loadAgentConfig>,
  initialIntervalSeconds: number,
): Promise<void> {
  let intervalSeconds = initialIntervalSeconds;
  let retryDelay = intervalSeconds * 1000;

  while (!stopping) {
    try {
      const upload = await sendMetrics(state, config);
      intervalSeconds = upload.heartbeatIntervalSeconds;
      await recordDebug(
        state,
        config,
        "metrics_upload",
        upload.debugMetrics,
      );
      retryDelay = intervalSeconds * 1000;
      await wait(retryDelay);
    } catch (error) {
      if (stopping) {
        return;
      }
      if (isPermanentClientError(error)) {
        await recordError(
          state,
          config,
          "metrics_upload",
          "Metrics upload rejected",
          error,
        );
        await wait(intervalSeconds * 1000);
        continue;
      }
      await recordError(
        state,
        config,
        "metrics_upload",
        "Metrics upload failed; retrying",
        error,
      );
      await wait(retryDelay);
      retryDelay = Math.min(retryDelay * 2, MAX_RETRY_DELAY_MS);
    }
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
      await recordDebug(state, config, "ssh_event_upload");
      return;
    } catch (error) {
      if (isPermanentClientError(error)) {
        throw error;
      }

      if (stopping) {
        return;
      }

      await recordError(
        state,
        config,
        "ssh_event_upload",
        "SSH event upload failed; retrying",
        error,
      );
      await wait(retryDelay);
      retryDelay = Math.min(retryDelay * 2, MAX_RETRY_DELAY_MS);
    }
  }
}

async function sendSudoAuthFailureWithRetry(
  event: NonNullable<ReturnType<typeof parseSudoJournalEntry>>,
  state: AgentState,
  config: ReturnType<typeof loadAgentConfig>,
): Promise<void> {
  let retryDelay = 1_000;

  while (!stopping) {
    try {
      await sendSudoAuthFailureEvent(event, state, config);
      await recordDebug(state, config, "sudo_event_upload");
      return;
    } catch (error) {
      if (isPermanentClientError(error)) {
        throw error;
      }

      if (stopping) {
        return;
      }

      await recordError(
        state,
        config,
        "sudo_event_upload",
        "Sudo authentication event upload failed; retrying",
        error,
      );
      await wait(retryDelay);
      retryDelay = Math.min(retryDelay * 2, MAX_RETRY_DELAY_MS);
    }
  }
}

async function followAuthenticationJournal(
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
      "--identifier=sudo",
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
  await recordDebug(state, config, "journal_reader_started");
  try {
    for await (const line of lines) {
      if (stopping) {
        break;
      }

      const event = parseSshJournalEntry(line);
      if (event) {
        await sendSshEventWithRetry(event, state, config);
      }
      const sudoEvent = parseSudoJournalEntry(line);
      if (sudoEvent) {
        await sendSudoAuthFailureWithRetry(sudoEvent, state, config);
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

async function runAuthenticationJournalReader(
  state: AgentState,
  config: ReturnType<typeof loadAgentConfig>,
): Promise<void> {
  while (!stopping) {
    try {
      await followAuthenticationJournal(state, config);
    } catch (error) {
      if (stopping) {
        return;
      }
      await recordError(
        state,
        config,
        "journal_reader",
        "Authentication journal reader stopped; retrying",
        error,
      );
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
      const heartbeat = await sendHeartbeat(state, config);
      heartbeatIntervalSeconds = heartbeat.heartbeatIntervalSeconds;
      state.debugEnabled = heartbeat.debugEnabled;
      await recordDebug(state, config, "heartbeat_upload");
      retryDelay = heartbeatIntervalSeconds * 1000;
      await wait(retryDelay);
    } catch (error) {
      if (isPermanentClientError(error)) {
        await recordError(
          state,
          config,
          "heartbeat_upload",
          "Heartbeat upload rejected",
          error,
        );
        throw new Error(
          "Receiver rejected the agent credential. Clear the agent state file and enroll the server again.",
        );
      }

      if (stopping) {
        return;
      }

      await recordError(
        state,
        config,
        "heartbeat_upload",
        "Heartbeat failed; retrying",
        error,
      );
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
  let debugEnabled = false;

  if (!state.enrollmentAccepted) {
    const redemption = await redeemWithRetry(state, config);
    if (!redemption) {
      return;
    }
    state = redemption.state;
    heartbeatIntervalSeconds = redemption.heartbeatIntervalSeconds;
    debugEnabled = redemption.debugEnabled;
    console.info("Agent enrollment completed");
    await recordDebug(state, config, "agent_enrollment_completed");
  } else {
    debugEnabled = state.debugEnabled === true;
  }
  state.debugEnabled = debugEnabled;

  console.info("Agent heartbeat service started");
  await Promise.all([
    runHeartbeats(state, config, heartbeatIntervalSeconds),
    runMetrics(state, config, heartbeatIntervalSeconds),
    runDockerWatch(state, config, heartbeatIntervalSeconds),
    runAuthenticationJournalReader(state, config),
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
