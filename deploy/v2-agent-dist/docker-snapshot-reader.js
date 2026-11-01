import { readFile } from "node:fs/promises";
import { DOCKER_SNAPSHOT_PATH } from "./docker-snapshot.js";
const MAX_DISCOVERED_CONTAINERS = 1_000;
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function validName(value) {
    return (typeof value === "string" &&
        /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value));
}
function validContainerSnapshot(value) {
    return (isRecord(value) &&
        validName(value.name) &&
        (value.state === "running" ||
            value.state === "stopped" ||
            value.state === "unhealthy" ||
            value.state === "missing") &&
        (value.healthStatus === null ||
            value.healthStatus === "none" ||
            value.healthStatus === "starting" ||
            value.healthStatus === "healthy" ||
            value.healthStatus === "unhealthy") &&
        typeof value.restartCount === "number" &&
        Number.isSafeInteger(value.restartCount) &&
        value.restartCount >= 0);
}
export function parseDockerSnapshot(value) {
    if (!isRecord(value) ||
        typeof value.sampledAtMs !== "number" ||
        !Number.isSafeInteger(value.sampledAtMs) ||
        value.sampledAtMs < 1) {
        throw new TypeError("Docker snapshot is invalid");
    }
    if (value.available === false) {
        if (typeof value.errorCode !== "string" ||
            !/^[A-Za-z0-9_.-]{1,80}$/.test(value.errorCode) ||
            !Array.isArray(value.containerNames) ||
            value.containerNames.length !== 0 ||
            !Array.isArray(value.containers) ||
            value.containers.length !== 0) {
            throw new TypeError("Unavailable Docker snapshot is invalid");
        }
        return {
            sampledAtMs: value.sampledAtMs,
            available: false,
            errorCode: value.errorCode,
            containerNames: [],
            containers: [],
        };
    }
    if (value.available !== true ||
        !Array.isArray(value.containerNames) ||
        value.containerNames.length > MAX_DISCOVERED_CONTAINERS ||
        !Array.isArray(value.containers) ||
        value.containers.length > MAX_DISCOVERED_CONTAINERS ||
        !value.containerNames.every(validName) ||
        !value.containers.every(validContainerSnapshot) ||
        new Set(value.containerNames).size !== value.containerNames.length ||
        new Set(value.containers.map((container) => container.name)).size !==
            value.containers.length) {
        throw new TypeError("Available Docker snapshot is invalid");
    }
    const containerNames = value.containerNames.filter(validName);
    const containers = value.containers.filter(validContainerSnapshot);
    return {
        sampledAtMs: value.sampledAtMs,
        available: true,
        containerNames,
        containers,
    };
}
export async function readDockerSnapshot(path = DOCKER_SNAPSHOT_PATH, read = readFile) {
    let contents;
    try {
        contents = await read(path, "utf8");
    }
    catch (error) {
        if (typeof error === "object" &&
            error !== null &&
            "code" in error &&
            (error.code === "ENOENT" ||
                error.code === "EACCES" ||
                error.code === "EPERM")) {
            return {
                sampledAtMs: Date.now(),
                available: false,
                errorCode: "docker_snapshot_unavailable",
                containerNames: [],
                containers: [],
            };
        }
        throw error;
    }
    let decoded;
    try {
        decoded = JSON.parse(contents);
    }
    catch {
        throw new TypeError("Docker snapshot file is not valid JSON");
    }
    return parseDockerSnapshot(decoded);
}
