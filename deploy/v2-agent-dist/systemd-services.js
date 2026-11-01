import { execFile } from "node:child_process";
const MAX_MONITORED_SERVICES = 20;
const SERVICE_TIMEOUT_MS = 2_000;
const SERVICE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.@:-]{0,127}\.service$/;
const SERVICE_STATES = new Set([
    "active",
    "activating",
    "deactivating",
    "failed",
    "inactive",
    "reloading",
]);
export function parseSystemdServiceUnits(value) {
    if (value === undefined || value.trim() === "") {
        return [];
    }
    const units = value.split(",").map((unit) => unit.trim());
    if (units.length > MAX_MONITORED_SERVICES ||
        units.some((unit) => !SERVICE_NAME_PATTERN.test(unit)) ||
        new Set(units).size !== units.length) {
        throw new TypeError("XGS_MONITOR_SERVICES must contain up to 20 unique systemd service units");
    }
    return units;
}
function isSystemdServiceState(value) {
    return SERVICE_STATES.has(value);
}
function readSystemdServiceState(name) {
    return new Promise((resolve) => {
        execFile("systemctl", ["is-active", name], {
            encoding: "utf8",
            timeout: SERVICE_TIMEOUT_MS,
            maxBuffer: 1_024,
            windowsHide: true,
        }, (_error, stdout) => {
            const state = stdout.trim();
            resolve(isSystemdServiceState(state) ? state : "unknown");
        });
    });
}
export async function collectSystemdServiceStatuses(units, readState = readSystemdServiceState) {
    if (units.length > MAX_MONITORED_SERVICES ||
        units.some((unit) => !SERVICE_NAME_PATTERN.test(unit)) ||
        new Set(units).size !== units.length) {
        throw new TypeError("Systemd service unit list is invalid");
    }
    const statuses = await Promise.all(units.map(async (name) => ({ name, state: await readState(name) })));
    return statuses.sort((left, right) => left.name.localeCompare(right.name));
}
