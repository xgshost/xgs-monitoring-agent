import type { AgentState } from "./state.js";
import type { AgentMetrics } from "./metrics.js";
import {
  AGENT_ERROR_OPERATIONS,
  getAgentErrorCode,
  reportAgentError,
} from "./error-reporting.js";

export const AGENT_DEBUG_OPERATIONS = [
  "agent_enrollment_completed",
  "heartbeat_upload",
  "metrics_upload",
  "docker_watch_policy_fetch",
  "docker_watch_status_upload",
  "docker_watch_inventory_upload",
  "ssh_event_upload",
  "sudo_event_upload",
  "journal_reader_started",
  "ssh_autoban_policy_sync",
] as const;

export type AgentDebugOperation = (typeof AGENT_DEBUG_OPERATIONS)[number];

export interface AgentDebugMetricsSummary {
  sampledAtMs: number;
  cpuUsagePercent: number;
  memory: {
    usedBytes: number;
    totalBytes: number;
    usedPercent: number;
  };
  rootFilesystem?: {
    usedBytes: number;
    totalBytes: number;
    usedPercent: number;
  };
}

export function summarizeAgentMetrics(
  metrics: AgentMetrics,
): AgentDebugMetricsSummary {
  const rootFilesystem = metrics.os.filesystems.find(
    (filesystem) => filesystem.mountPoint === "/",
  );
  return {
    sampledAtMs: metrics.sampledAtMs,
    cpuUsagePercent: metrics.os.cpuUsagePercent,
    memory: {
      usedBytes: metrics.os.memory.usedBytes,
      totalBytes: metrics.os.memory.totalBytes,
      usedPercent: metrics.os.memory.usedPercent,
    },
    ...(rootFilesystem
      ? {
          rootFilesystem: {
            usedBytes: rootFilesystem.usedBytes,
            totalBytes: rootFilesystem.totalBytes,
            usedPercent: rootFilesystem.usedPercent,
          },
        }
      : {}),
  };
}

export async function reportAgentDebug(
  filePath: string,
  monitorBaseUrl: string,
  state: AgentState,
  operation: AgentDebugOperation,
  request: typeof fetch = fetch,
  metrics: AgentDebugMetricsSummary | undefined = undefined,
): Promise<void> {
  if (!AGENT_DEBUG_OPERATIONS.includes(operation)) {
    throw new TypeError("Invalid agent debug operation");
  }
  if (metrics !== undefined && operation !== "metrics_upload") {
    throw new TypeError("Metrics summaries are only valid for metrics uploads");
  }
  if (!state.enrollmentAccepted || state.debugEnabled !== true) {
    return;
  }

  try {
    const response = await request(
      `${monitorBaseUrl}/api/v1/agents/debug-events`,
      {
        method: "POST",
        headers: {
          authorization: `******`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          operation,
          occurredAtMs: Date.now(),
          ...(metrics === undefined ? {} : { metrics }),
        }),
        signal: AbortSignal.timeout(3_000),
      },
    );
    if (!response.ok) {
      const error = Object.assign(
        new Error(`Debug event was rejected with HTTP ${response.status}`),
        { statusCode: response.status },
      );
      await reportAgentError(
        filePath,
        monitorBaseUrl,
        state,
        "debug_event_upload",
        error,
        request,
      );
    }
  } catch (error) {
    await reportAgentError(
      filePath,
      monitorBaseUrl,
      state,
      "debug_event_upload",
      error,
      request,
    );
  }
}
