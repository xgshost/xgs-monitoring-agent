import { readDockerSnapshot } from "./docker-snapshot-reader.js";
const DEFAULT_HEARTBEAT_SECONDS = 60;
const MAX_RETRY_SECONDS = 60;
const MAX_WATCHED_CONTAINERS = 100;
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function validContainerName(value) {
    return (typeof value === "string" &&
        /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value));
}
function parsePolicy(value) {
    if (!isRecord(value) ||
        value.status !== "ok" ||
        typeof value.revision !== "number" ||
        !Number.isSafeInteger(value.revision) ||
        value.revision < 1 ||
        typeof value.restartThreshold !== "number" ||
        !Number.isSafeInteger(value.restartThreshold) ||
        value.restartThreshold < 2 ||
        value.restartThreshold > 100 ||
        typeof value.windowMinutes !== "number" ||
        !Number.isSafeInteger(value.windowMinutes) ||
        value.windowMinutes < 1 ||
        value.windowMinutes > 60 ||
        !Array.isArray(value.containers) ||
        value.containers.length > MAX_WATCHED_CONTAINERS ||
        !value.containers.every(validContainerName) ||
        new Set(value.containers).size !== value.containers.length) {
        throw new TypeError("Monitoring API Docker policy is invalid");
    }
    return {
        revision: value.revision,
        restartThreshold: value.restartThreshold,
        windowMinutes: value.windowMinutes,
        containers: value.containers,
    };
}
function parseErrorCode(error) {
    if (typeof error === "object" &&
        error !== null &&
        "code" in error &&
        typeof error.code === "string" &&
        /^[A-Za-z0-9_.-]{1,80}$/.test(error.code)) {
        return error.code;
    }
    if (typeof error === "object" &&
        error !== null &&
        "status" in error &&
        typeof error.status === "number") {
        return `Http${error.status}`;
    }
    return error instanceof TypeError ? "InvalidDockerPolicy" : "DockerWatchError";
}
async function fetchJson(fetchImpl, url, token, signal, method, body) {
    const response = await fetchImpl(url, {
        method,
        headers: {
            accept: "application/json",
            authorization: "Bearer " + token,
            ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
    });
    if (!response.ok) {
        throw Object.assign(new Error("Docker monitoring API request failed"), {
            status: response.status,
        });
    }
    try {
        return (await response.json());
    }
    catch {
        throw new TypeError("Docker monitoring API response was invalid");
    }
}
async function fetchPolicy(settings) {
    const value = await fetchJson(settings.fetchImpl, new URL("/api/v1/agents/docker-policy", settings.apiBaseUrl), settings.agentToken, settings.signal, "GET");
    return parsePolicy(value);
}
function watchedContainers(containers, names) {
    return containers.filter((container) => names.has(container.name));
}
async function collectAndReport(settings) {
    const policy = await fetchPolicy(settings);
    await settings.reportDebug?.("docker_watch_policy_fetch");
    const snapshot = await (settings.readSnapshot ?? readDockerSnapshot)();
    const watchedNames = new Set(policy.containers);
    const observed = snapshot.available
        ? watchedContainers(snapshot.containers, watchedNames)
        : [];
    const observedNames = new Set(observed.map((container) => container.name));
    if (snapshot.available) {
        for (const name of policy.containers) {
            if (!observedNames.has(name)) {
                observed.push({
                    name,
                    state: "missing",
                    healthStatus: null,
                    restartCount: 0,
                });
            }
        }
    }
    const report = {
        revision: policy.revision,
        sampledAtMs: snapshot.sampledAtMs,
        available: snapshot.available,
        ...(snapshot.available ? {} : { errorCode: snapshot.errorCode }),
        containerNames: snapshot.containerNames,
        containers: observed,
    };
    await fetchJson(settings.fetchImpl, new URL("/api/v1/agents/docker-report", settings.apiBaseUrl), settings.agentToken, settings.signal, "POST", report);
    await settings.reportDebug?.("docker_watch_status_upload");
    await settings.reportDebug?.("docker_watch_inventory_upload");
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
export async function runDockerWatchCollector(settings) {
    let intervalSeconds = settings.heartbeatIntervalSeconds ?? DEFAULT_HEARTBEAT_SECONDS;
    let retrySeconds = 1;
    while (!settings.signal.aborted) {
        let waitSeconds = intervalSeconds;
        try {
            await collectAndReport(settings);
            retrySeconds = 1;
        }
        catch (error) {
            if (settings.signal.aborted) {
                return;
            }
            if (typeof error === "object" &&
                error !== null &&
                "status" in error &&
                (error.status === 401 || error.status === 403)) {
                throw error;
            }
            settings.reportError(parseErrorCode(error));
            waitSeconds = retrySeconds;
            retrySeconds = Math.min(retrySeconds * 2, MAX_RETRY_SECONDS);
        }
        await waitForInterval(waitSeconds * 1000, settings.signal);
    }
}
