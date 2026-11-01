import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { isIP } from "node:net";
import { createInterface } from "node:readline";
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function journalTimestamp(value) {
    if (typeof value !== "string" && typeof value !== "number") {
        return undefined;
    }
    const microseconds = Number(value);
    if (!Number.isSafeInteger(microseconds) || microseconds < 1) {
        return undefined;
    }
    return Math.floor(microseconds / 1_000);
}
export function parseSshJournalEntry(line) {
    if (Buffer.byteLength(line, "utf8") > 8_192) {
        return undefined;
    }
    let record;
    try {
        record = JSON.parse(line);
    }
    catch {
        return undefined;
    }
    if (!isRecord(record) || typeof record.MESSAGE !== "string") {
        return undefined;
    }
    const match = /^(Accepted|Failed)\s+(?:password|publickey|keyboard-interactive(?:\/pam)?)\s+for\s+(?:invalid user\s+)?(\S+)\s+from\s+(\S+)\s+port\s+\d+(?:\s|$)/.exec(record.MESSAGE);
    const username = match?.[2];
    const sourceIp = match?.[3];
    const occurredAtMs = journalTimestamp(record.__REALTIME_TIMESTAMP);
    if (!username ||
        !sourceIp ||
        username.length > 128 ||
        isIP(sourceIp) === 0 ||
        occurredAtMs === undefined) {
        return undefined;
    }
    return {
        id: randomUUID(),
        outcome: match?.[1] === "Accepted" ? "success" : "failure",
        username,
        sourceIp,
        occurredAtMs,
    };
}
export function parseSudoJournalEntry(line) {
    if (Buffer.byteLength(line, "utf8") > 8_192) {
        return undefined;
    }
    let record;
    try {
        record = JSON.parse(line);
    }
    catch {
        return undefined;
    }
    if (!isRecord(record) ||
        (record.SYSLOG_IDENTIFIER !== "sudo" && record._COMM !== "sudo") ||
        typeof record.MESSAGE !== "string" ||
        !/pam_[a-z0-9_-]+\(sudo:auth\): authentication failure;/i.test(record.MESSAGE)) {
        return undefined;
    }
    const logname = /(?:^|\s)logname=([^\s;]*)/.exec(record.MESSAGE)?.[1];
    const uid = /(?:^|\s)uid=(\d+)(?:\s|;|$)/.exec(record.MESSAGE)?.[1];
    const username = logname && logname !== "-" ? logname : uid ? `uid:${uid}` : undefined;
    const occurredAtMs = journalTimestamp(record.__REALTIME_TIMESTAMP);
    if (!username ||
        username.length > 128 ||
        /[\u0000-\u001f\u007f]/.test(username) ||
        occurredAtMs === undefined) {
        return undefined;
    }
    return {
        id: randomUUID(),
        outcome: "sudo_failure",
        username,
        sourceIp: null,
        occurredAtMs,
    };
}
function errorCode(error) {
    if (typeof error === "object" &&
        error !== null &&
        "status" in error &&
        typeof error.status === "number") {
        return `Http${error.status}`;
    }
    if (typeof error === "object" &&
        error !== null &&
        "code" in error &&
        typeof error.code === "string" &&
        /^[A-Za-z0-9_.-]{1,80}$/.test(error.code)) {
        return error.code;
    }
    return "SshEventError";
}
function wait(milliseconds, signal) {
    if (signal.aborted) {
        return Promise.resolve();
    }
    return new Promise((resolve) => {
        const timer = setTimeout(finish, milliseconds);
        const onAbort = () => finish();
        function finish() {
            clearTimeout(timer);
            signal.removeEventListener("abort", onAbort);
            resolve();
        }
        signal.addEventListener("abort", onAbort, { once: true });
    });
}
async function sendEventWithRetry(event, settings) {
    let retrySeconds = 1;
    while (!settings.signal.aborted) {
        try {
            const response = await settings.fetchImpl(new URL("/api/v1/agents/ssh-events", settings.apiBaseUrl), {
                method: "POST",
                headers: {
                    authorization: "Bearer " + settings.agentToken,
                    "content-type": "application/json",
                    accept: "application/json",
                },
                body: JSON.stringify(event),
                cache: "no-store",
                redirect: "error",
                signal: AbortSignal.timeout(10_000),
            });
            if (!response.ok) {
                throw Object.assign(new Error("SSH event upload failed"), {
                    status: response.status,
                });
            }
            await settings.reportDebug?.(event.outcome === "sudo_failure"
                ? "sudo_event_upload"
                : "ssh_event_upload");
            return;
        }
        catch (error) {
            settings.reportError(errorCode(error), event.outcome === "sudo_failure"
                ? "sudo_event_upload"
                : "ssh_event_upload");
            await wait(retrySeconds * 1_000, settings.signal);
            retrySeconds = Math.min(retrySeconds * 2, 60);
        }
    }
}
async function followAuthenticationJournal(settings) {
    const child = spawn("journalctl", [
        "--follow",
        "--lines=0",
        "--output=json",
        "--no-pager",
        "--identifier=sshd",
        "--identifier=sudo",
    ], { stdio: ["ignore", "pipe", "pipe"] });
    let permissionDenied = false;
    let spawnFailure;
    child.on("error", (error) => {
        spawnFailure = error;
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk) => {
        if (/permission denied|insufficient permissions/i.test(chunk)) {
            permissionDenied = true;
        }
    });
    const terminate = () => child.kill("SIGTERM");
    settings.signal.addEventListener("abort", terminate, { once: true });
    const closed = new Promise((resolve) => {
        child.once("close", (code, signal) => resolve({ code, signal }));
    });
    if (!child.stdout) {
        child.kill("SIGTERM");
        settings.signal.removeEventListener("abort", terminate);
        throw new Error("journalctl_stdout_unavailable");
    }
    await settings.reportDebug?.("journal_reader_started");
    const lines = createInterface({ input: child.stdout });
    try {
        for await (const line of lines) {
            if (settings.signal.aborted) {
                break;
            }
            const event = parseSshJournalEntry(line) ?? parseSudoJournalEntry(line);
            if (event) {
                await sendEventWithRetry(event, settings);
            }
        }
    }
    finally {
        lines.close();
        settings.signal.removeEventListener("abort", terminate);
        if (child.exitCode === null && child.signalCode === null) {
            child.kill("SIGTERM");
        }
    }
    const exit = await closed;
    if (settings.signal.aborted) {
        return;
    }
    if (spawnFailure) {
        throw new Error("journalctl_spawn_failed");
    }
    if (permissionDenied) {
        throw new Error("journal_read_permission_required");
    }
    throw new Error(`journalctl_exited_${exit.code ?? "unknown"}`);
}
export async function runSshJournalCollector(settings) {
    while (!settings.signal.aborted) {
        try {
            await followAuthenticationJournal(settings);
        }
        catch (error) {
            if (settings.signal.aborted) {
                return;
            }
            settings.reportError(errorCode(error), "journal_reader");
            await wait(30_000, settings.signal);
        }
    }
}
