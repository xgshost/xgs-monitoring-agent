import { randomUUID } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync, } from "node:fs";
import { join } from "node:path";
export const AGENT_ERROR_OPERATIONS = [
    "enrollment",
    "heartbeat_upload",
    "metrics_upload",
    "ssh_event_upload",
    "sudo_event_upload",
    "journal_reader",
    "docker_watch_upload",
    "debug_event_upload",
    "ssh_autoban_sync",
    "agent_startup",
];
const MAX_AGENT_ERROR_LOG_BYTES = 1_048_576;
const ERROR_CODE_PATTERN = /^[A-Za-z0-9_.-]{1,80}$/;
function safeErrorCode(error) {
    if (typeof error === "object" &&
        error !== null &&
        "status" in error &&
        typeof error.status === "number" &&
        Number.isSafeInteger(error.status)) {
        return `Http${error.status}`;
    }
    if (typeof error === "object" &&
        error !== null &&
        "code" in error &&
        typeof error.code === "string" &&
        ERROR_CODE_PATTERN.test(error.code)) {
        return error.code;
    }
    if (error instanceof Error && ERROR_CODE_PATTERN.test(error.name)) {
        return error.name;
    }
    return "UnknownError";
}
function appendAgentErrorLog(stateDirectory, report) {
    const filePath = join(stateDirectory, "agent-errors.jsonl");
    const line = `${JSON.stringify(report)}\n`;
    const lineBytes = Buffer.byteLength(line, "utf8");
    if (lineBytes > MAX_AGENT_ERROR_LOG_BYTES) {
        throw new RangeError("Agent error log entry exceeds its size limit");
    }
    mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
    if (existsSync(filePath) &&
        statSync(filePath).size + lineBytes > MAX_AGENT_ERROR_LOG_BYTES) {
        const rotatedPath = `${filePath}.1`;
        if (existsSync(rotatedPath)) {
            unlinkSync(rotatedPath);
        }
        renameSync(filePath, rotatedPath);
    }
    appendFileSync(filePath, line, { encoding: "utf8", mode: 0o600 });
    chmodSync(filePath, 0o600);
}
export async function reportAgentDiagnosticError(stateDirectory, apiBaseUrl, agentToken, operation, errorCode, request = fetch, forward = true) {
    if (!AGENT_ERROR_OPERATIONS.includes(operation) ||
        !ERROR_CODE_PATTERN.test(errorCode)) {
        throw new TypeError("Agent diagnostic error is invalid");
    }
    const occurredAtMs = Date.now();
    const report = {
        eventId: randomUUID(),
        severity: "ERROR",
        component: operation.split(/[_.-]/, 1)[0] ?? "agent",
        operation,
        status: "failed",
        errorCode,
        occurredAtMs,
    };
    try {
        appendAgentErrorLog(stateDirectory, {
            operation,
            errorCode,
            occurredAtMs,
        });
    }
    catch (writeError) {
        console.error("XGS Monitoring agent could not write local error log", safeErrorCode(writeError));
    }
    if (!forward) {
        return;
    }
    try {
        const response = await request(new URL("/api/v1/agents/diagnostics", apiBaseUrl), {
            method: "POST",
            headers: {
                authorization: `Bearer ${agentToken}`,
                "content-type": "application/json",
                accept: "application/json",
            },
            body: JSON.stringify(report),
            cache: "no-store",
            redirect: "error",
            signal: AbortSignal.timeout(3_000),
        });
        if (!response.ok) {
            console.warn("XGS Monitoring agent error report was not accepted", `Http${response.status}`);
        }
    }
    catch (reportError) {
        console.warn("XGS Monitoring agent could not forward error report", safeErrorCode(reportError));
    }
}
