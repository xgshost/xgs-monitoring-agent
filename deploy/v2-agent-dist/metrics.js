import { readFileSync, statfsSync } from "node:fs";
import { platform, release, uptime } from "node:os";
import { collectSystemdServiceStatuses, } from "./systemd-services.js";
const MAX_FILESYSTEMS = 40;
const PSEUDO_FILESYSTEMS = new Set([
    "autofs",
    "binfmt_misc",
    "cgroup",
    "cgroup2",
    "configfs",
    "debugfs",
    "devpts",
    "devtmpfs",
    "efivarfs",
    "fusectl",
    "hugetlbfs",
    "mqueue",
    "overlay",
    "proc",
    "pstore",
    "securityfs",
    "sysfs",
    "tmpfs",
    "tracefs",
]);
const PSEUDO_MOUNT_POINTS = new Set([
    "/etc/pve",
    "/run/rpc_pipefs",
    "/var/lib/lxcfs",
]);
const SKIPPED_FILESYSTEM_ERRORS = new Set([
    "EACCES",
    "ENOENT",
    "ENOTDIR",
    "EPERM",
]);
export function parseCpuCounters(contents) {
    const line = contents.split(/\r?\n/).find((entry) => /^cpu\s/.test(entry));
    if (!line) {
        throw new Error("CPU counters are missing from /proc/stat");
    }
    const values = line
        .trim()
        .split(/\s+/)
        .slice(1)
        .map(Number);
    if (values.length < 4 ||
        values.some((value) => !Number.isSafeInteger(value) || value < 0)) {
        throw new Error("CPU counters in /proc/stat are invalid");
    }
    return {
        total: values.slice(0, 8).reduce((sum, value) => sum + value, 0),
        idle: (values[3] ?? 0) + (values[4] ?? 0),
    };
}
export function cpuUsagePercent(before, after) {
    const totalDelta = after.total - before.total;
    const idleDelta = after.idle - before.idle;
    if (!Number.isSafeInteger(totalDelta) ||
        !Number.isSafeInteger(idleDelta) ||
        totalDelta < 1 ||
        idleDelta < 0 ||
        idleDelta > totalDelta) {
        throw new Error("CPU counter delta is invalid");
    }
    return Number((((totalDelta - idleDelta) / totalDelta) * 100).toFixed(2));
}
export function parseMemoryInfo(contents) {
    const values = new Map();
    for (const line of contents.split(/\r?\n/)) {
        const match = /^([A-Za-z][A-Za-z0-9_()]*):\s+(\d+)\s+kB$/.exec(line);
        if (match?.[1] !== undefined && match[2] !== undefined) {
            values.set(match[1], Number(match[2]) * 1024);
        }
    }
    const totalBytes = values.get("MemTotal");
    const availableBytes = values.get("MemAvailable");
    const swapTotalBytes = values.get("SwapTotal");
    const swapAvailableBytes = values.get("SwapFree");
    if (totalBytes === undefined ||
        availableBytes === undefined ||
        swapTotalBytes === undefined ||
        swapAvailableBytes === undefined ||
        [totalBytes, availableBytes, swapTotalBytes, swapAvailableBytes].some((value) => !Number.isSafeInteger(value) || value < 0) ||
        availableBytes > totalBytes ||
        swapAvailableBytes > swapTotalBytes) {
        throw new Error("Required memory counters in /proc/meminfo are invalid");
    }
    return { totalBytes, availableBytes, swapTotalBytes, swapAvailableBytes };
}
function decodeMountField(value) {
    return value.replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(Number.parseInt(octal, 8)));
}
export function parseMountInfo(contents) {
    const mounts = new Map();
    for (const line of contents.split(/\r?\n/)) {
        if (!line) {
            continue;
        }
        const separator = line.indexOf(" - ");
        if (separator < 0) {
            continue;
        }
        const beforeSeparator = line.slice(0, separator).split(" ");
        const afterSeparator = line.slice(separator + 3).split(" ");
        const deviceId = beforeSeparator[2] ?? "";
        const mountPoint = decodeMountField(beforeSeparator[4] ?? "");
        const filesystem = afterSeparator[0] ?? "";
        if (!mountPoint.startsWith("/") ||
            !filesystem ||
            PSEUDO_FILESYSTEMS.has(filesystem) ||
            PSEUDO_MOUNT_POINTS.has(mountPoint) ||
            mounts.has(mountPoint)) {
            continue;
        }
        mounts.set(mountPoint, { filesystem, deviceId });
    }
    const seenDevices = new Set();
    return Array.from(mounts, ([mountPoint, mount]) => ({
        mountPoint,
        ...mount,
    }))
        .sort((left, right) => left.mountPoint.localeCompare(right.mountPoint))
        .filter(({ deviceId }) => {
        if (!deviceId) {
            return true;
        }
        if (seenDevices.has(deviceId)) {
            return false;
        }
        seenDevices.add(deviceId);
        return true;
    })
        .slice(0, MAX_FILESYSTEMS)
        .map(({ mountPoint, filesystem }) => ({ mountPoint, filesystem }));
}
function toSafeNumber(value, label) {
    if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new RangeError(`${label} is outside the supported numeric range`);
    }
    return Number(value);
}
function collectFilesystems() {
    const mounts = parseMountInfo(readFileSync("/proc/self/mountinfo", "utf8"));
    const filesystems = [];
    for (const mount of mounts) {
        try {
            const stats = statfsSync(mount.mountPoint, { bigint: true });
            const totalBytesBig = stats.blocks * stats.bsize;
            const availableBytesBig = stats.bavail * stats.bsize;
            const usedBytesBig = totalBytesBig - availableBytesBig;
            const totalBytes = toSafeNumber(totalBytesBig, "Filesystem size");
            const availableBytes = toSafeNumber(availableBytesBig, "Filesystem available space");
            const usedBytes = toSafeNumber(usedBytesBig, "Filesystem used space");
            const totalInodes = stats.files > 0n ? toSafeNumber(stats.files, "Filesystem inode count") : null;
            const usedInodesPercent = totalInodes === null
                ? null
                : Number((((stats.files - stats.ffree) * 100n * 100n) /
                    stats.files).toString()) / 100;
            filesystems.push({
                ...mount,
                totalBytes,
                usedBytes,
                availableBytes,
                usedPercent: totalBytes === 0
                    ? 0
                    : Number(((usedBytes / totalBytes) * 100).toFixed(2)),
                totalInodes,
                usedInodesPercent,
            });
        }
        catch (error) {
            if (typeof error === "object" &&
                error !== null &&
                "code" in error &&
                typeof error.code === "string" &&
                SKIPPED_FILESYSTEM_ERRORS.has(error.code)) {
                continue;
            }
            throw error;
        }
    }
    return filesystems;
}
async function sampleCpuUsage() {
    const before = parseCpuCounters(readFileSync("/proc/stat", "utf8"));
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const after = parseCpuCounters(readFileSync("/proc/stat", "utf8"));
    return cpuUsagePercent(before, after);
}
export async function collectHostMetrics(monitoredServices = []) {
    if (platform() !== "linux") {
        throw new Error("Host metrics collection is supported on Linux only");
    }
    const memoryInfo = parseMemoryInfo(readFileSync("/proc/meminfo", "utf8"));
    const memoryUsedBytes = memoryInfo.totalBytes - memoryInfo.availableBytes;
    const swapUsedBytes = memoryInfo.swapTotalBytes - memoryInfo.swapAvailableBytes;
    return {
        schemaVersion: 1,
        sampledAtMs: Date.now(),
        os: {
            platform: platform(),
            release: release(),
            uptimeSeconds: Math.floor(uptime()),
            cpuUsagePercent: await sampleCpuUsage(),
            memory: {
                totalBytes: memoryInfo.totalBytes,
                usedBytes: memoryUsedBytes,
                availableBytes: memoryInfo.availableBytes,
                usedPercent: Number(((memoryUsedBytes / memoryInfo.totalBytes) * 100).toFixed(2)),
                swapTotalBytes: memoryInfo.swapTotalBytes,
                swapUsedBytes,
                swapUsedPercent: memoryInfo.swapTotalBytes === 0
                    ? 0
                    : Number(((swapUsedBytes / memoryInfo.swapTotalBytes) *
                        100).toFixed(2)),
            },
            filesystems: collectFilesystems(),
        },
        services: await collectSystemdServiceStatuses(monitoredServices),
    };
}
