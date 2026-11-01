import { pathToFileURL } from "node:url";
import { collectHostInventory } from "./inventory.js";
import { collectHostMetrics } from "./metrics.js";
import { enrollAgent, readInstalledAgentRelease, runAgentUpdateCheck, runMonitoringAgent, } from "./runtime.js";
import { runSshJournalCollector } from "./ssh-events.js";
import { parseSystemdServiceUnits } from "./systemd-services.js";
import { runSshBanPolicySync } from "./ssh-ban-sync.js";
import { collectDockerSnapshot, writeDockerSnapshot, } from "./docker-snapshot.js";
import { runDockerWatchCollector } from "./docker-watch.js";
function requiredEnvironment(name) {
    const value = process.env[name]?.trim();
    if (!value) {
        throw new Error(`${name}_missing`);
    }
    return value;
}
function safeErrorCode(error) {
    if (typeof error === "object" &&
        error !== null &&
        "code" in error &&
        typeof error.code === "string" &&
        /^[A-Za-z0-9_.-]{1,80}$/.test(error.code)) {
        return error.code;
    }
    if (error instanceof Error && /^[A-Za-z0-9_.-]{1,80}$/.test(error.name)) {
        return error.name;
    }
    return "AgentError";
}
function agentSettings() {
    const stateDirectory = process.env.XGS_AGENT_STATE_DIRECTORY?.trim();
    const sshAutobanSetting = process.env.XGS_MONITOR_SSH_AUTOBAN?.trim();
    if (sshAutobanSetting !== undefined &&
        sshAutobanSetting !== "" &&
        sshAutobanSetting !== "0" &&
        sshAutobanSetting !== "1") {
        throw new TypeError("XGS_MONITOR_SSH_AUTOBAN must be 0 or 1");
    }
    return {
        apiBaseUrl: requiredEnvironment("XGS_MONITORING_API_URL"),
        serverName: requiredEnvironment("XGS_MONITORING_SERVER_NAME"),
        sshAutobanOptIn: sshAutobanSetting === "1",
        ...(stateDirectory ? { stateDirectory } : {}),
    };
}
async function enroll() {
    const settings = agentSettings();
    const monitoredServices = parseSystemdServiceUnits(process.env.XGS_MONITOR_SERVICES);
    const result = await enrollAgent(settings, {
        collectMetrics: () => collectHostMetrics(monitoredServices),
        collectInventory: collectHostInventory,
    });
    console.log(`XGS Monitoring enrollment request ${result.requestId} submitted (${result.status}); waiting for staff approval`);
}
async function run() {
    const controller = new AbortController();
    const agentRelease = await readInstalledAgentRelease(requiredEnvironment("XGS_AGENT_INSTALL_DIRECTORY"));
    const monitoredServices = parseSystemdServiceUnits(process.env.XGS_MONITOR_SERVICES);
    const stop = () => controller.abort();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    process.once("SIGUSR1", stop);
    try {
        await runMonitoringAgent({
            ...agentSettings(),
            heartbeatIntervalSeconds: Number(process.env.MONITORING_HEARTBEAT_INTERVAL_SECONDS ?? 60),
        }, controller.signal, {
            agentRelease,
            collectMetrics: () => collectHostMetrics(monitoredServices),
            collectInventory: collectHostInventory,
            collectSshEvents: runSshJournalCollector,
            collectDockerWatch: runDockerWatchCollector,
            reportError: (code) => console.error("XGS Monitoring agent request failed", code),
        });
    }
    finally {
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
        process.off("SIGUSR1", stop);
    }
}
async function syncSshBans() {
    await runSshBanPolicySync(agentSettings(), {
        fetchImpl: fetch,
        reportError: (code) => console.error("XGS Monitoring agent request failed", code),
    });
}
async function updateAgent() {
    const result = await runAgentUpdateCheck(agentSettings(), requiredEnvironment("XGS_AGENT_INSTALL_DIRECTORY"));
    console.log(`XGS Monitoring agent release ${result.version}: ${result.status}`);
}
async function collectDockerSnapshotOnce() {
    const snapshot = await collectDockerSnapshot();
    await writeDockerSnapshot(snapshot);
    if (!snapshot.available) {
        console.error("XGS Docker snapshot collection unavailable", snapshot.errorCode);
    }
}
async function main() {
    const command = process.argv[2];
    if (command === "enroll") {
        await enroll();
        return;
    }
    if (command === "run") {
        await run();
        return;
    }
    if (command === "sync-ssh-bans") {
        await syncSshBans();
        return;
    }
    if (command === "update") {
        await updateAgent();
        return;
    }
    if (command === "collect-docker-snapshot") {
        await collectDockerSnapshotOnce();
        return;
    }
    throw new Error("Usage: agent <enroll|run|update|sync-ssh-bans|collect-docker-snapshot>");
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((error) => {
        console.error("XGS Monitoring agent failed", safeErrorCode(error));
        process.exitCode = 1;
    });
}
