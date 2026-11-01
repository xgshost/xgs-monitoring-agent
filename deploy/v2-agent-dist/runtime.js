import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readlink, readFile, rename, rm, symlink, unlink, } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep, } from "node:path";
import { collectHostInventory } from "./inventory.js";
import { collectHostMetrics } from "./metrics.js";
import { reportAgentDebug, summarizeAgentMetrics, } from "./debug-reporting.js";
import { reportAgentDiagnosticError, } from "./diagnostic-reporting.js";
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEFAULT_HEARTBEAT_SECONDS = 60;
const MAX_RETRY_SECONDS = 60;
const MAX_ENROLLMENT_RETRIES = 5;
const MAX_RELEASE_FILES = 128;
const MAX_RELEASE_BYTES = 16 * 1024 * 1024;
const MAX_RELEASE_FILE_BYTES = 2 * 1024 * 1024;
function statePath(stateDirectory, fileName) {
    return join(stateDirectory, fileName);
}
function resolveStateDirectory(stateDirectory) {
    return stateDirectory ?? join(homedir(), ".local", "state", "xgs-monitoring-agent");
}
export async function readInstalledAgentRelease(installationRoot) {
    if (!installationRoot.trim() || !isAbsolute(installationRoot)) {
        throw new TypeError("Agent installation root must be an absolute path");
    }
    const contents = await readFile(join(resolve(installationRoot), "current", "VERSION"), "utf8");
    const [releaseVersion, releaseHash, ...extra] = contents.trim().split(/\r?\n/);
    if (extra.length > 0 ||
        !releaseVersion ||
        !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(releaseVersion) ||
        !releaseHash ||
        !/^[a-f0-9]{64}$/.test(releaseHash)) {
        throw new Error("Installed agent release metadata is invalid");
    }
    return { releaseVersion, releaseHash };
}
export function normalizedBaseUrl(value) {
    let url;
    try {
        url = new URL(value);
    }
    catch {
        throw new TypeError("Monitoring API URL is invalid");
    }
    const localHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);
    if ((url.protocol !== "https:" &&
        !(url.protocol === "http:" && localHosts.has(url.hostname))) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash) {
        throw new TypeError("Monitoring API URL must use HTTPS");
    }
    if (url.pathname !== "/") {
        throw new TypeError("Monitoring API URL must not include a path");
    }
    return url;
}
function validateServerName(serverName) {
    const normalized = serverName.trim();
    if (normalized.length < 1 ||
        normalized.length > 64 ||
        /[\u0000-\u001f\u007f]/.test(normalized)) {
        throw new TypeError("Monitoring server name is invalid");
    }
    return normalized;
}
async function ensurePrivateStateDirectory(path) {
    await mkdir(path, { recursive: true, mode: 0o700 });
    const info = await lstat(path);
    if (!info.isDirectory() || (info.mode & 0o077) !== 0) {
        throw new Error("Agent state directory must be a private directory");
    }
    if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
        throw new Error("Agent state directory is not owned by the agent user");
    }
}
async function readPrivateValue(stateDirectory, fileName, pattern) {
    const path = statePath(stateDirectory, fileName);
    const info = await lstat(path);
    if (!info.isFile() ||
        (info.mode & 0o077) !== 0 ||
        (typeof process.getuid === "function" && info.uid !== process.getuid())) {
        throw new Error("Agent credential file permissions or ownership are invalid");
    }
    const token = (await readFile(path, "utf8")).trim();
    if (!pattern.test(token)) {
        throw new Error("Agent state file is invalid");
    }
    return token;
}
async function loadOrCreatePrivateValue(stateDirectory, fileName, pattern, createValue) {
    await ensurePrivateStateDirectory(stateDirectory);
    try {
        return await readPrivateValue(stateDirectory, fileName, pattern);
    }
    catch (error) {
        if (typeof error !== "object" ||
            error === null ||
            !("code" in error) ||
            error.code !== "ENOENT") {
            throw error;
        }
    }
    const token = createValue();
    const path = statePath(stateDirectory, fileName);
    let file;
    try {
        file = await open(path, "wx", 0o600);
    }
    catch (error) {
        if (typeof error === "object" &&
            error !== null &&
            "code" in error &&
            error.code === "EEXIST") {
            return readPrivateValue(stateDirectory, fileName, pattern);
        }
        throw error;
    }
    try {
        await file.writeFile(`${token}\n`, "utf8");
        await file.sync();
    }
    finally {
        await file.close();
    }
    await chmod(path, 0o600);
    return token;
}
async function readAgentToken(stateDirectory) {
    return readPrivateValue(stateDirectory, "agent-token", TOKEN_PATTERN);
}
async function loadOrCreateAgentToken(stateDirectory) {
    return loadOrCreatePrivateValue(stateDirectory, "agent-token", TOKEN_PATTERN, () => randomBytes(32).toString("base64url"));
}
function errorCode(error) {
    if (typeof error === "object" &&
        error !== null &&
        "status" in error &&
        typeof error.status === "number") {
        return `Http${error.status}`;
    }
    if (error instanceof TypeError) {
        return "NetworkOrPayloadError";
    }
    return "AgentRequestError";
}
async function postJson(fetchImpl, url, body, token) {
    const headers = {
        "content-type": "application/json",
        accept: "application/json",
    };
    if (token) {
        headers.authorization = `Bearer ${token}`;
    }
    const response = await fetchImpl(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
        throw Object.assign(new Error("Monitoring API request failed"), {
            status: response.status,
        });
    }
    try {
        return (await response.json());
    }
    catch {
        throw new TypeError("Monitoring API response was invalid");
    }
}
async function getJson(fetchImpl, url, token) {
    const response = await fetchImpl(url, {
        method: "GET",
        headers: {
            accept: "application/json",
            authorization: `Bearer ${token}`,
        },
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
        throw Object.assign(new Error("Monitoring API request failed"), {
            status: response.status,
        });
    }
    try {
        return (await response.json());
    }
    catch {
        throw new TypeError("Monitoring API response was invalid");
    }
}
function heartbeatIntervalFrom(value) {
    if (typeof value !== "object" ||
        value === null ||
        !("heartbeatIntervalSeconds" in value) ||
        typeof value.heartbeatIntervalSeconds !== "number" ||
        !Number.isSafeInteger(value.heartbeatIntervalSeconds) ||
        value.heartbeatIntervalSeconds < 1 ||
        value.heartbeatIntervalSeconds > 86_400) {
        throw new TypeError("Monitoring API heartbeat interval is invalid");
    }
    return value.heartbeatIntervalSeconds;
}
function heartbeatDebugModeFrom(value) {
    if (typeof value !== "object" ||
        value === null) {
        throw new TypeError("Monitoring API debug mode is invalid");
    }
    if (!("debugEnabled" in value)) {
        return false;
    }
    if (typeof value.debugEnabled !== "boolean") {
        throw new TypeError("Monitoring API debug mode is invalid");
    }
    return value.debugEnabled;
}
export async function enrollAgent(settings, options = {}) {
    const baseUrl = normalizedBaseUrl(settings.apiBaseUrl);
    const serverName = validateServerName(settings.serverName);
    const stateDirectory = resolveStateDirectory(settings.stateDirectory);
    const fetchImpl = options.fetchImpl ?? fetch;
    const agentToken = await loadOrCreateAgentToken(stateDirectory);
    const requestToken = await loadOrCreatePrivateValue(stateDirectory, "enrollment-request-token", TOKEN_PATTERN, () => randomBytes(32).toString("base64url"));
    const installId = await loadOrCreatePrivateValue(stateDirectory, "enrollment-install-id", UUID_PATTERN, randomUUID);
    const metrics = await (options.collectMetrics ?? collectHostMetrics)();
    const inventory = await (options.collectInventory ?? collectHostInventory)(metrics);
    const result = await postJson(fetchImpl, new URL("/api/v1/agents/enrollment-requests", baseUrl), {
        installId,
        requestToken,
        agentToken,
        serverName,
        hostname: inventory.hostname,
        sshAutobanOptIn: settings.sshAutobanOptIn ?? false,
        inventory,
    });
    const requestId = typeof result === "object" &&
        result !== null &&
        "requestId" in result &&
        typeof result.requestId === "string"
        ? result.requestId
        : null;
    if (typeof result !== "object" ||
        result === null ||
        !("status" in result) ||
        (result.status !== "pending" &&
            result.status !== "queued" &&
            result.status !== "active" &&
            result.status !== "denied" &&
            result.status !== "failed" &&
            result.status !== "completed") ||
        requestId === null ||
        !UUID_PATTERN.test(requestId) ||
        !("pollAfterSeconds" in result) ||
        typeof result.pollAfterSeconds !== "number" ||
        !Number.isSafeInteger(result.pollAfterSeconds) ||
        result.pollAfterSeconds < 1 ||
        result.pollAfterSeconds > 86_400) {
        throw new TypeError("Monitoring API enrollment response is invalid");
    }
    const savedRequestId = await loadOrCreatePrivateValue(stateDirectory, "enrollment-request-id", UUID_PATTERN, () => requestId);
    if (savedRequestId !== requestId) {
        throw new Error("Agent enrollment request identity changed");
    }
    return {
        status: result.status === "completed" ? "active" : result.status,
        requestId,
        pollAfterSeconds: result.pollAfterSeconds,
    };
}
function parseEnrollmentStatus(value) {
    if (typeof value !== "object" ||
        value === null ||
        !("status" in value) ||
        (value.status !== "pending" &&
            value.status !== "queued" &&
            value.status !== "active" &&
            value.status !== "denied" &&
            value.status !== "failed") ||
        !("pollAfterSeconds" in value) ||
        typeof value.pollAfterSeconds !== "number" ||
        !Number.isSafeInteger(value.pollAfterSeconds) ||
        value.pollAfterSeconds < 1 ||
        value.pollAfterSeconds > 86_400) {
        throw new TypeError("Monitoring API enrollment status is invalid");
    }
    if (value.status === "active") {
        return {
            status: value.status,
            pollAfterSeconds: value.pollAfterSeconds,
            heartbeatIntervalSeconds: heartbeatIntervalFrom(value),
        };
    }
    return { status: value.status, pollAfterSeconds: value.pollAfterSeconds };
}
function waitForInterval(milliseconds, signal) {
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
async function waitForEnrollmentApproval(baseUrl, requestId, requestToken, fetchImpl, signal, reportError) {
    let retrySeconds = 1;
    let consecutiveFailures = 0;
    while (!signal.aborted) {
        try {
            const result = parseEnrollmentStatus(await getJson(fetchImpl, new URL(`/api/v1/agents/enrollment-requests/${requestId}`, baseUrl), requestToken));
            consecutiveFailures = 0;
            retrySeconds = 1;
            if (result.status === "active") {
                if (result.heartbeatIntervalSeconds === undefined) {
                    throw new TypeError("Monitoring API heartbeat interval is invalid");
                }
                return result.heartbeatIntervalSeconds;
            }
            if (result.status === "denied" || result.status === "failed") {
                reportError?.(result.status === "denied" ? "EnrollmentDenied" : "EnrollmentFailed");
                return null;
            }
            await waitForInterval(result.pollAfterSeconds * 1000, signal);
        }
        catch (error) {
            reportError?.(errorCode(error));
            consecutiveFailures += 1;
            if (consecutiveFailures >= MAX_ENROLLMENT_RETRIES) {
                throw new Error("Enrollment status retries exhausted");
            }
            await waitForInterval(retrySeconds * 1000, signal);
            retrySeconds = Math.min(retrySeconds * 2, MAX_RETRY_SECONDS);
        }
    }
    return null;
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function validReleasePath(path) {
    return (path.length > 0 &&
        path.length <= 512 &&
        !isAbsolute(path) &&
        !path.split(/[\\/]/).some((part) => part === "" || part === "." || part === "..") &&
        /^[A-Za-z0-9._/-]+$/.test(path) &&
        path.endsWith(".js"));
}
function parseReleaseManifest(value) {
    if (!isRecord(value) ||
        value.schemaVersion !== 1 ||
        typeof value.version !== "string" ||
        !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(value.version) ||
        !Array.isArray(value.files) ||
        value.files.length < 1 ||
        value.files.length > MAX_RELEASE_FILES) {
        throw new TypeError("Agent release manifest is invalid");
    }
    let totalBytes = 0;
    const files = value.files.map((entry) => {
        if (!isRecord(entry) ||
            typeof entry.path !== "string" ||
            !validReleasePath(entry.path) ||
            typeof entry.sizeBytes !== "number" ||
            !Number.isSafeInteger(entry.sizeBytes) ||
            entry.sizeBytes < 0 ||
            entry.sizeBytes > MAX_RELEASE_FILE_BYTES ||
            typeof entry.sha256 !== "string" ||
            !/^[a-f0-9]{64}$/.test(entry.sha256)) {
            throw new TypeError("Agent release manifest file entry is invalid");
        }
        totalBytes += entry.sizeBytes;
        if (totalBytes > MAX_RELEASE_BYTES) {
            throw new TypeError("Agent release exceeds the size limit");
        }
        return {
            path: entry.path,
            sizeBytes: entry.sizeBytes,
            sha256: entry.sha256,
        };
    });
    if (new Set(files.map((file) => file.path)).size !== files.length ||
        !files.some((file) => file.path === "index.js")) {
        throw new TypeError("Agent release manifest file list is invalid");
    }
    return { schemaVersion: 1, version: value.version, files };
}
function compareReleaseVersions(left, right) {
    const leftParts = (left.split("-")[0] ?? "").split(".").map(Number);
    const rightParts = (right.split("-")[0] ?? "").split(".").map(Number);
    for (let index = 0; index < 3; index += 1) {
        const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
        if (difference !== 0) {
            return difference;
        }
    }
    if (left === right) {
        return 0;
    }
    return left.includes("-") ? -1 : 1;
}
async function getBytes(fetchImpl, url, token) {
    const response = await fetchImpl(url, {
        method: "GET",
        headers: {
            accept: "application/javascript",
            authorization: `Bearer ${token}`,
        },
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
        throw Object.assign(new Error("Agent release download failed"), {
            status: response.status,
        });
    }
    const contents = Buffer.from(await response.arrayBuffer());
    if (contents.length > MAX_RELEASE_FILE_BYTES) {
        throw new TypeError("Agent release file exceeds the size limit");
    }
    return contents;
}
async function privateDirectory(path) {
    const info = await lstat(path);
    if (!info.isDirectory() ||
        info.isSymbolicLink() ||
        (info.mode & 0o022) !== 0 ||
        (typeof process.getuid === "function" && info.uid !== process.getuid())) {
        throw new Error("Agent update directory permissions or ownership are invalid");
    }
}
async function writeAgentPid(stateDirectory) {
    const path = statePath(stateDirectory, "agent-pid");
    try {
        const info = await lstat(path);
        if (!info.isFile() ||
            info.isSymbolicLink() ||
            (info.mode & 0o077) !== 0 ||
            (typeof process.getuid === "function" && info.uid !== process.getuid())) {
            throw new Error("Agent process state file permissions are invalid");
        }
    }
    catch (error) {
        if (typeof error !== "object" ||
            error === null ||
            !("code" in error) ||
            error.code !== "ENOENT") {
            throw error;
        }
    }
    const file = await open(path, "w", 0o600);
    try {
        await file.writeFile(`${process.pid}\n`, "utf8");
        await file.sync();
    }
    finally {
        await file.close();
    }
    await chmod(path, 0o600);
}
async function removeAgentPid(stateDirectory) {
    try {
        await unlink(statePath(stateDirectory, "agent-pid"));
    }
    catch (error) {
        if (typeof error !== "object" ||
            error === null ||
            !("code" in error) ||
            error.code !== "ENOENT") {
            throw error;
        }
    }
}
async function restartRunningAgent(stateDirectory, entryPoint) {
    let pid;
    try {
        const pidText = await readPrivateValue(stateDirectory, "agent-pid", /^\d{1,10}$/);
        pid = Number(pidText);
    }
    catch (error) {
        if (typeof error === "object" &&
            error !== null &&
            "code" in error &&
            error.code === "ENOENT") {
            return false;
        }
        throw error;
    }
    if (!Number.isSafeInteger(pid) || pid < 2 || pid === process.pid) {
        return false;
    }
    let processInfo;
    try {
        processInfo = await lstat(`/proc/${pid}`);
    }
    catch (error) {
        if (typeof error === "object" &&
            error !== null &&
            "code" in error &&
            error.code === "ENOENT") {
            return false;
        }
        throw error;
    }
    if (typeof process.getuid === "function" &&
        processInfo.uid !== process.getuid()) {
        throw new Error("Agent process identity does not match the update account");
    }
    let commandLine;
    try {
        commandLine = (await readFile(`/proc/${pid}/cmdline`, "utf8"))
            .split("\u0000")
            .filter(Boolean);
    }
    catch (error) {
        if (typeof error === "object" &&
            error !== null &&
            "code" in error &&
            error.code === "ENOENT") {
            return false;
        }
        throw error;
    }
    if (!commandLine.includes(entryPoint)) {
        throw new Error("Agent process identity does not match the installed agent");
    }
    try {
        process.kill(pid, "SIGUSR1");
    }
    catch (error) {
        if (typeof error === "object" &&
            error !== null &&
            "code" in error &&
            error.code === "ESRCH") {
            return false;
        }
        throw error;
    }
    return true;
}
export async function runAgentUpdateCheck(settings, installationRoot, fetchImpl = fetch) {
    if (!installationRoot.trim() || !isAbsolute(installationRoot)) {
        throw new TypeError("Agent installation root must be an absolute path");
    }
    const baseUrl = normalizedBaseUrl(settings.apiBaseUrl);
    const stateDirectory = resolveStateDirectory(settings.stateDirectory);
    await ensurePrivateStateDirectory(stateDirectory);
    const agentToken = await readAgentToken(stateDirectory);
    const manifest = parseReleaseManifest(await getJson(fetchImpl, new URL("/api/v1/agents/releases/latest", baseUrl), agentToken));
    const root = resolve(installationRoot);
    if (root === dirname(root) || basename(root) === "") {
        throw new TypeError("Agent installation root is invalid");
    }
    await privateDirectory(root);
    const releasesDirectory = join(root, "releases");
    try {
        await mkdir(releasesDirectory, { mode: 0o700 });
    }
    catch (error) {
        if (typeof error !== "object" ||
            error === null ||
            !("code" in error) ||
            error.code !== "EEXIST") {
            throw error;
        }
    }
    await privateDirectory(releasesDirectory);
    const releaseHash = createHash("sha256")
        .update(manifest.files
        .map((file) => `${file.path}:${file.sha256}`)
        .sort()
        .join("\n"))
        .digest("hex");
    const targetName = `${manifest.version}-${releaseHash.slice(0, 12)}`;
    const targetRelativePath = `releases/${targetName}`;
    const currentPath = join(root, "current");
    let currentVersion = "0.0.0";
    let currentHash = "";
    let currentTarget = null;
    try {
        const currentInfo = await lstat(currentPath);
        if (!currentInfo.isSymbolicLink()) {
            throw new Error("Agent current release path must be a symbolic link");
        }
        currentTarget = await readlink(currentPath);
        if (!currentTarget.startsWith("releases/") ||
            currentTarget.includes("..") ||
            isAbsolute(currentTarget)) {
            throw new Error("Agent current release link is invalid");
        }
        const versionContents = await readFile(join(root, currentTarget, "VERSION"), "utf8");
        const [version, hash] = versionContents.trim().split("\n");
        if (!version ||
            !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(version) ||
            !hash ||
            !/^[a-f0-9]{64}$/.test(hash)) {
            throw new Error("Installed agent version metadata is invalid");
        }
        currentVersion = version;
        currentHash = hash;
    }
    catch (error) {
        if (typeof error !== "object" ||
            error === null ||
            !("code" in error) ||
            error.code !== "ENOENT") {
            throw error;
        }
    }
    if (compareReleaseVersions(manifest.version, currentVersion) < 0) {
        throw new Error("Agent release downgrade is not allowed");
    }
    if (manifest.version === currentVersion && releaseHash === currentHash) {
        return { status: "current", version: manifest.version };
    }
    const targetPath = join(releasesDirectory, targetName);
    const stagingPath = join(releasesDirectory, `.staging-${randomUUID()}`);
    let targetCreated = false;
    let releaseActivated = false;
    await mkdir(stagingPath, { mode: 0o700 });
    try {
        for (const file of manifest.files) {
            const encodedPath = file.path
                .split("/")
                .map((part) => encodeURIComponent(part))
                .join("/");
            const contents = await getBytes(fetchImpl, new URL(`/api/v1/agents/releases/files/${encodedPath}`, baseUrl), agentToken);
            if (contents.length !== file.sizeBytes ||
                createHash("sha256").update(contents).digest("hex") !== file.sha256) {
                throw new Error("Agent release file integrity check failed");
            }
            const destination = resolve(stagingPath, file.path);
            const destinationRelative = relative(stagingPath, destination);
            if (destinationRelative.startsWith(`..${sep}`) ||
                destinationRelative === ".." ||
                isAbsolute(destinationRelative)) {
                throw new TypeError("Agent release path is invalid");
            }
            const parentDirectory = dirname(destination);
            await mkdir(parentDirectory, { recursive: true, mode: 0o700 });
            const output = await open(destination, "wx", 0o644);
            try {
                await output.writeFile(contents);
                await output.sync();
            }
            finally {
                await output.close();
            }
        }
        const versionFile = await open(join(stagingPath, "VERSION"), "wx", 0o644);
        try {
            await versionFile.writeFile(`${manifest.version}\n${releaseHash}\n`, "utf8");
            await versionFile.sync();
        }
        finally {
            await versionFile.close();
        }
        try {
            await lstat(targetPath);
            throw new Error("Agent release target already exists");
        }
        catch (error) {
            if (typeof error !== "object" ||
                error === null ||
                !("code" in error) ||
                error.code !== "ENOENT") {
                throw error;
            }
        }
        await rename(stagingPath, targetPath);
        targetCreated = true;
        const nextLink = join(root, `.current-${randomUUID()}`);
        await symlink(targetRelativePath, nextLink);
        try {
            await rename(nextLink, currentPath);
        }
        catch (error) {
            try {
                await unlink(nextLink);
            }
            catch (cleanupError) {
                if (typeof cleanupError !== "object" ||
                    cleanupError === null ||
                    !("code" in cleanupError) ||
                    cleanupError.code !== "ENOENT") {
                    throw cleanupError;
                }
            }
            throw error;
        }
        releaseActivated = true;
        const restarted = await restartRunningAgent(stateDirectory, join(root, "current", "index.js"));
        if (!restarted) {
            return { status: "updated", version: manifest.version };
        }
        return { status: "updated", version: manifest.version };
    }
    catch (error) {
        if (targetCreated && !releaseActivated) {
            await rm(targetPath, { recursive: true, force: true });
        }
        await rm(stagingPath, { recursive: true, force: true });
        throw error;
    }
}
export async function runMonitoringAgent(settings, signal, options = {}) {
    const baseUrl = normalizedBaseUrl(settings.apiBaseUrl);
    const stateDirectory = resolveStateDirectory(settings.stateDirectory);
    const fetchImpl = options.fetchImpl ?? fetch;
    const collectMetrics = options.collectMetrics;
    if (!collectMetrics) {
        throw new TypeError("Metrics collector is required");
    }
    await ensurePrivateStateDirectory(stateDirectory);
    let requestId;
    try {
        requestId = await readPrivateValue(stateDirectory, "enrollment-request-id", UUID_PATTERN);
    }
    catch (error) {
        if (typeof error !== "object" ||
            error === null ||
            !("code" in error) ||
            error.code !== "ENOENT") {
            throw error;
        }
        requestId = (await enrollAgent(settings, {
            fetchImpl,
            collectMetrics,
            ...(options.collectInventory
                ? { collectInventory: options.collectInventory }
                : {}),
        })).requestId;
    }
    const requestToken = await readPrivateValue(stateDirectory, "enrollment-request-token", TOKEN_PATTERN);
    const token = await readAgentToken(stateDirectory);
    const reportEnrollmentError = (code) => {
        options.reportError?.(code, "enrollment");
        void reportAgentDiagnosticError(stateDirectory, baseUrl, token, "enrollment", code, fetchImpl, false);
    };
    const approvedHeartbeatInterval = await waitForEnrollmentApproval(baseUrl, requestId, requestToken, fetchImpl, signal, reportEnrollmentError);
    if (approvedHeartbeatInterval === null) {
        return;
    }
    let intervalSeconds = approvedHeartbeatInterval;
    if (!Number.isSafeInteger(intervalSeconds) ||
        intervalSeconds < 1 ||
        intervalSeconds > 86_400) {
        throw new TypeError("Agent heartbeat interval is invalid");
    }
    let retrySeconds = 1;
    let debugEnabled = false;
    let enrollmentDebugReported = false;
    const taskController = new AbortController();
    const abortTasks = () => taskController.abort();
    if (signal.aborted) {
        abortTasks();
    }
    else {
        signal.addEventListener("abort", abortTasks, { once: true });
    }
    await writeAgentPid(stateDirectory);
    const reportDebug = async (operation, metrics) => {
        if (!debugEnabled) {
            return;
        }
        try {
            await reportAgentDebug(baseUrl, token, operation, fetchImpl, metrics);
        }
        catch (error) {
            reportOperationalError("debug_event_upload", errorCode(error));
        }
    };
    const reportOperationalError = (operation, code) => {
        options.reportError?.(code, operation);
        void reportAgentDiagnosticError(stateDirectory, baseUrl, token, operation, code, fetchImpl);
    };
    const heartbeatTask = async () => {
        while (!taskController.signal.aborted) {
            let waitSeconds = intervalSeconds;
            let operation = "heartbeat_upload";
            try {
                const heartbeat = await postJson(fetchImpl, new URL("/api/v1/agents/heartbeat", baseUrl), options.agentRelease ?? {}, token);
                intervalSeconds = heartbeatIntervalFrom(heartbeat);
                debugEnabled = heartbeatDebugModeFrom(heartbeat);
                if (!enrollmentDebugReported) {
                    await reportDebug("agent_enrollment_completed");
                    enrollmentDebugReported = true;
                }
                await reportDebug("heartbeat_upload");
                operation = "metrics_upload";
                const metrics = await collectMetrics();
                await postJson(fetchImpl, new URL("/api/v1/agents/metrics", baseUrl), metrics, token);
                await reportDebug("metrics_upload", summarizeAgentMetrics(metrics));
                retrySeconds = 1;
            }
            catch (error) {
                reportOperationalError(operation, errorCode(error));
                if (typeof error === "object" &&
                    error !== null &&
                    "status" in error &&
                    (error.status === 401 || error.status === 403)) {
                    throw error;
                }
                waitSeconds = retrySeconds;
                retrySeconds = Math.min(retrySeconds * 2, MAX_RETRY_SECONDS);
            }
            await waitForInterval(waitSeconds * 1000, taskController.signal);
        }
    };
    const tasks = [heartbeatTask()];
    if (options.collectSshEvents) {
        tasks.push(options.collectSshEvents({
            apiBaseUrl: baseUrl,
            agentToken: token,
            fetchImpl,
            signal: taskController.signal,
            reportError: (code, operation) => reportOperationalError(operation ?? "ssh_event_upload", code),
            reportDebug,
        }));
    }
    if (options.collectDockerWatch) {
        tasks.push(options.collectDockerWatch({
            apiBaseUrl: baseUrl,
            agentToken: token,
            fetchImpl,
            signal: taskController.signal,
            reportError: (code, operation) => reportOperationalError(operation ?? "docker_watch_upload", code),
            reportDebug,
            heartbeatIntervalSeconds: settings.heartbeatIntervalSeconds ?? DEFAULT_HEARTBEAT_SECONDS,
        }));
    }
    let primaryFailure;
    let failed = false;
    try {
        await Promise.race(tasks);
    }
    catch (error) {
        primaryFailure = error;
        failed = true;
    }
    finally {
        taskController.abort();
        signal.removeEventListener("abort", abortTasks);
        const settled = await Promise.allSettled(tasks);
        for (const result of settled) {
            if (result.status === "rejected" &&
                (!failed || result.reason !== primaryFailure)) {
                reportOperationalError("agent_startup", errorCode(result.reason));
            }
        }
        await removeAgentPid(stateDirectory);
    }
    if (failed) {
        throw primaryFailure;
    }
}
