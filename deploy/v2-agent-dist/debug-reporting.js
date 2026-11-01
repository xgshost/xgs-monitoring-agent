import { randomUUID } from "node:crypto";
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
];
export function summarizeAgentMetrics(metrics) {
    const rootFilesystem = metrics.os.filesystems.find((filesystem) => filesystem.mountPoint === "/");
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
export async function reportAgentDebug(apiBaseUrl, agentToken, operation, request = fetch, metrics) {
    if ((metrics !== undefined && operation !== "metrics_upload") ||
        (metrics === undefined && operation === "metrics_upload")) {
        throw new TypeError("Agent debug metrics do not match the operation");
    }
    const response = await request(new URL("/api/v1/agents/debug-events", apiBaseUrl), {
        method: "POST",
        headers: {
            authorization: `Bearer ${agentToken}`,
            "content-type": "application/json",
            accept: "application/json",
        },
        body: JSON.stringify({
            eventId: randomUUID(),
            operation,
            occurredAtMs: Date.now(),
            ...(metrics === undefined ? {} : { metrics }),
        }),
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok) {
        throw Object.assign(new Error("Agent debug event upload failed"), {
            status: response.status,
        });
    }
}
