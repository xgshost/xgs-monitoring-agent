import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { open, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
const MAX_DISCOVERED_CONTAINERS = 1_000;
const INSPECT_CONCURRENCY = 10;
const DOCKER_COMMAND_TIMEOUT_MS = 5_000;
const INSPECT_FORMAT = "{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}|{{.RestartCount}}";
export const DOCKER_SNAPSHOT_PATH = "/run/xgs-monitor-agent-docker/snapshot.json";
export class DockerSnapshotError extends Error {
    errorCode;
    constructor(errorCode) {
        super(errorCode);
        this.errorCode = errorCode;
        this.name = "DockerSnapshotError";
    }
}
function runDocker(args, maxBuffer) {
    return new Promise((resolve) => {
        execFile("docker", args, {
            encoding: "utf8",
            timeout: DOCKER_COMMAND_TIMEOUT_MS,
            maxBuffer,
            windowsHide: true,
        }, (error, stdout, stderr) => {
            const code = error && typeof error.code === "string" ? error.code : undefined;
            const status = error && typeof error.code === "number"
                ? error.code
                : error
                    ? null
                    : 0;
            resolve({
                status,
                stdout,
                stderr,
                ...(code ? { errorCode: code } : {}),
            });
        });
    });
}
function commandFailureCode(result) {
    if (result.errorCode === "ENOENT") {
        return "docker_cli_unavailable";
    }
    if (result.errorCode === "ETIMEDOUT") {
        return "docker_command_timeout";
    }
    return "docker_daemon_unavailable";
}
function validContainerName(name) {
    return /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(name);
}
function parseContainerNames(result) {
    if (result.errorCode || result.status !== 0) {
        throw new DockerSnapshotError(commandFailureCode(result));
    }
    const output = result.stdout.trim();
    if (!output) {
        return [];
    }
    const names = output.split(/\r?\n/);
    if (names.length > MAX_DISCOVERED_CONTAINERS ||
        names.some((name) => !validContainerName(name)) ||
        new Set(names).size !== names.length) {
        throw new DockerSnapshotError("docker_inventory_invalid_response");
    }
    return names;
}
function parseContainerSnapshot(name, result) {
    if (result.errorCode) {
        throw new DockerSnapshotError(commandFailureCode(result));
    }
    if (result.status !== 0) {
        if (/No such (?:object|container)/i.test(result.stderr)) {
            return {
                name,
                state: "missing",
                healthStatus: null,
                restartCount: 0,
            };
        }
        throw new DockerSnapshotError(commandFailureCode(result));
    }
    const [dockerState, healthValue, restartValue, ...extra] = result.stdout.trim().split("|");
    const restartCount = Number(restartValue);
    if (extra.length > 0 ||
        !dockerState ||
        !/^[a-z]+$/.test(dockerState) ||
        !["none", "starting", "healthy", "unhealthy"].includes(healthValue ?? "") ||
        !Number.isSafeInteger(restartCount) ||
        restartCount < 0) {
        throw new DockerSnapshotError("docker_inspect_invalid_response");
    }
    const healthStatus = healthValue === "none" ||
        healthValue === "starting" ||
        healthValue === "healthy" ||
        healthValue === "unhealthy"
        ? healthValue
        : null;
    return {
        name,
        state: dockerState === "running"
            ? healthStatus === "unhealthy"
                ? "unhealthy"
                : "running"
            : "stopped",
        healthStatus,
        restartCount,
    };
}
export async function collectDockerSnapshot(runCommand = runDocker, sampledAtMs = Date.now()) {
    if (!Number.isSafeInteger(sampledAtMs) || sampledAtMs < 1) {
        throw new TypeError("Docker snapshot sample time is invalid");
    }
    try {
        const containerNames = parseContainerNames(await runCommand(["container", "ls", "--all", "--format", "{{.Names}}"], 256 * 1024));
        const containers = [];
        for (let offset = 0; offset < containerNames.length; offset += INSPECT_CONCURRENCY) {
            const batch = await Promise.all(containerNames
                .slice(offset, offset + INSPECT_CONCURRENCY)
                .map(async (name) => parseContainerSnapshot(name, await runCommand(["container", "inspect", "--format", INSPECT_FORMAT, name], 4_096))));
            containers.push(...batch);
        }
        return {
            sampledAtMs,
            available: true,
            containerNames,
            containers,
        };
    }
    catch (error) {
        if (!(error instanceof DockerSnapshotError)) {
            throw error;
        }
        return {
            sampledAtMs,
            available: false,
            errorCode: error.errorCode,
            containerNames: [],
            containers: [],
        };
    }
}
export async function writeDockerSnapshot(snapshot, outputPath = DOCKER_SNAPSHOT_PATH) {
    const temporaryPath = join(dirname(outputPath), `.${randomUUID()}.snapshot.tmp`);
    let published = false;
    try {
        const file = await open(temporaryPath, "wx", 0o640);
        try {
            await file.writeFile(`${JSON.stringify(snapshot)}\n`, "utf8");
            await file.sync();
        }
        finally {
            await file.close();
        }
        await rename(temporaryPath, outputPath);
        published = true;
    }
    finally {
        if (!published) {
            try {
                await unlink(temporaryPath);
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
    }
}
