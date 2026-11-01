import { execFileSync } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { isIP } from "node:net";
import { join } from "node:path";
import { normalizedBaseUrl, } from "./runtime.js";
import { reportAgentDebug, } from "./debug-reporting.js";
import { reportAgentDiagnosticError, } from "./diagnostic-reporting.js";
const FAIL2BAN_JAIL = "xgs-monitor-agent";
const MAX_BANS = 10_000;
const MAX_BANS_PER_BATCH = 100;
const MAX_BAN_TTL_MS = 365 * 86_400_000;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function defaultFail2banRunner(args) {
    return execFileSync("fail2ban-client", args, {
        encoding: "utf8",
        timeout: 10_000,
        maxBuffer: 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
    });
}
function canonicalIpAddress(value) {
    const family = isIP(value);
    if (family === 4) {
        return value.split(".").map((part) => String(Number(part))).join(".");
    }
    if (family === 6) {
        return new URL(`http://[${value}]`).hostname.slice(1, -1);
    }
    throw new TypeError("SSH ban policy contains an invalid IP address");
}
function validateSshBanPolicy(value, now) {
    if (!isRecord(value) ||
        value.status !== "ok" ||
        typeof value.enabled !== "boolean" ||
        ("debugEnabled" in value && typeof value.debugEnabled !== "boolean") ||
        typeof value.revision !== "number" ||
        !Number.isSafeInteger(value.revision) ||
        value.revision < 1 ||
        !Array.isArray(value.bans) ||
        value.bans.length > MAX_BANS ||
        !Number.isSafeInteger(now) ||
        now < 1) {
        throw new TypeError("SSH ban policy response is invalid");
    }
    const addresses = new Set();
    const bans = value.bans.map((ban) => {
        if (!isRecord(ban) ||
            typeof ban.sourceIp !== "string" ||
            !("expiresAtMs" in ban) ||
            (ban.expiresAtMs !== null &&
                (typeof ban.expiresAtMs !== "number" ||
                    !Number.isSafeInteger(ban.expiresAtMs) ||
                    ban.expiresAtMs < 1 ||
                    ban.expiresAtMs > now + MAX_BAN_TTL_MS)) ||
            Object.keys(ban).some((key) => !["sourceIp", "expiresAtMs"].includes(key))) {
            throw new TypeError("SSH ban policy contains an invalid ban");
        }
        const sourceIp = canonicalIpAddress(ban.sourceIp);
        if (addresses.has(sourceIp)) {
            throw new TypeError("SSH ban policy contains duplicate IP addresses");
        }
        addresses.add(sourceIp);
        return { sourceIp, expiresAtMs: ban.expiresAtMs };
    });
    if (Object.keys(value).some((key) => !["status", "enabled", "revision", "bans", "debugEnabled"].includes(key))) {
        throw new TypeError("SSH ban policy response contains unexpected fields");
    }
    return {
        enabled: value.enabled,
        revision: value.revision,
        bans,
        debugEnabled: value.debugEnabled === true,
    };
}
export function parseFail2banBanList(output) {
    const trimmed = output.trim();
    if (!trimmed) {
        return [];
    }
    const addresses = trimmed.split(/[\s,]+/).map(canonicalIpAddress);
    return [...new Set(addresses)].sort();
}
function batches(items, size) {
    const result = [];
    for (let offset = 0; offset < items.length; offset += size) {
        result.push(items.slice(offset, offset + size));
    }
    return result;
}
export function syncFail2banPolicy(policy, now, runFail2ban = defaultFail2banRunner) {
    if (!Number.isSafeInteger(now) ||
        now < 1 ||
        !Number.isSafeInteger(policy.revision) ||
        policy.revision < 1 ||
        !Array.isArray(policy.bans) ||
        policy.bans.length > MAX_BANS) {
        throw new TypeError("Invalid Fail2ban sync inputs");
    }
    const desired = new Set();
    for (const ban of policy.bans) {
        const sourceIp = canonicalIpAddress(ban.sourceIp);
        if (ban.expiresAtMs !== null &&
            (!Number.isSafeInteger(ban.expiresAtMs) ||
                ban.expiresAtMs <= now ||
                ban.expiresAtMs > now + MAX_BAN_TTL_MS)) {
            continue;
        }
        if (desired.has(sourceIp)) {
            throw new TypeError("SSH ban policy contains duplicate IP addresses");
        }
        desired.add(sourceIp);
    }
    const current = new Set(parseFail2banBanList(runFail2ban(["get", FAIL2BAN_JAIL, "banip", ","])));
    const toUnban = [...current].filter((address) => !desired.has(address));
    const toBan = [...desired].filter((address) => !current.has(address));
    for (const chunk of batches(toUnban, MAX_BANS_PER_BATCH)) {
        runFail2ban(["set", FAIL2BAN_JAIL, "unbanip", ...chunk]);
    }
    for (const chunk of batches(toBan, MAX_BANS_PER_BATCH)) {
        runFail2ban(["set", FAIL2BAN_JAIL, "banip", ...chunk]);
    }
    return desired.size;
}
async function readRootAgentToken(stateDirectory) {
    if (typeof process.getuid !== "function" || process.getuid() !== 0) {
        throw new Error("ssh_ban_sync_requires_root");
    }
    const directoryInfo = await lstat(stateDirectory);
    if (!directoryInfo.isDirectory() ||
        directoryInfo.uid === 0 ||
        (directoryInfo.mode & 0o077) !== 0) {
        throw new Error("ssh_ban_sync_state_directory_permissions_invalid");
    }
    const tokenPath = join(stateDirectory, "agent-token");
    const info = await lstat(tokenPath);
    if (!info.isFile() ||
        info.uid === 0 ||
        (info.mode & 0o077) !== 0) {
        throw new Error("ssh_ban_sync_credential_permissions_invalid");
    }
    const token = (await readFile(tokenPath, "utf8")).trim();
    if (!TOKEN_PATTERN.test(token)) {
        throw new Error("ssh_ban_sync_credential_invalid");
    }
    return token;
}
async function requestJson(fetchImpl, url, token, method, body) {
    const response = await fetchImpl(url, {
        method,
        headers: {
            accept: "application/json",
            authorization: `Bearer ${token}`,
            ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
        throw Object.assign(new Error("SSH autoban API request failed"), {
            status: response.status,
        });
    }
    try {
        return (await response.json());
    }
    catch {
        throw new TypeError("SSH autoban API response was invalid");
    }
}
export async function runSshBanPolicySync(settings, options = {}) {
    const baseUrl = normalizedBaseUrl(settings.apiBaseUrl);
    const stateDirectory = settings.stateDirectory ??
        join(process.env.HOME ?? "/root", ".local", "state", "xgs-monitoring-agent");
    const readToken = options.readToken ?? readRootAgentToken;
    const token = await readToken(stateDirectory);
    const fetchImpl = options.fetchImpl ?? fetch;
    const now = options.now ?? Date.now;
    const reportError = async (error) => {
        const code = safeErrorCode(error);
        options.reportError?.(code, "ssh_autoban_sync");
        await reportAgentDiagnosticError(stateDirectory, baseUrl, token, "ssh_autoban_sync", code, fetchImpl);
        return code;
    };
    let rawPolicy;
    try {
        rawPolicy = await requestJson(fetchImpl, new URL("/api/v1/agents/ssh-ban-policy", baseUrl), token, "GET");
    }
    catch (error) {
        await reportError(error);
        throw error;
    }
    let policy;
    try {
        policy = validateSshBanPolicy(rawPolicy, now());
    }
    catch (error) {
        await reportError(error);
        throw error;
    }
    let activeBanCount;
    try {
        activeBanCount = syncFail2banPolicy(policy, now(), options.runFail2ban);
    }
    catch (error) {
        const code = await reportError(error);
        await reportSyncStatus(fetchImpl, baseUrl, token, policy.revision, "failed", null, code);
        throw error;
    }
    try {
        await reportSyncStatus(fetchImpl, baseUrl, token, policy.revision, "applied", activeBanCount, null);
    }
    catch (error) {
        await reportError(error);
        throw error;
    }
    if (policy.debugEnabled) {
        try {
            if (options.reportDebug) {
                await options.reportDebug("ssh_autoban_policy_sync");
            }
            else {
                await reportAgentDebug(baseUrl, token, "ssh_autoban_policy_sync", fetchImpl);
            }
        }
        catch (error) {
            await reportError(error);
        }
    }
}
async function reportSyncStatus(fetchImpl, baseUrl, token, policyRevision, status, activeBanCount, errorCode) {
    const result = await requestJson(fetchImpl, new URL("/api/v1/agents/ssh-ban-status", baseUrl), token, "POST", { policyRevision, status, activeBanCount, errorCode });
    if (!isRecord(result) || result.status !== "accepted") {
        throw new TypeError("SSH autoban status response is invalid");
    }
}
function safeErrorCode(error) {
    if (isRecord(error) &&
        typeof error.code === "string" &&
        /^[A-Za-z0-9_.-]{1,80}$/.test(error.code)) {
        return error.code;
    }
    if (error instanceof Error && /^[A-Za-z0-9_.-]{1,80}$/.test(error.name)) {
        return error.name;
    }
    return "SshBanSyncError";
}
