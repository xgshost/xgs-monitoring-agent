import { readdir, readFile } from "node:fs/promises";
import { arch, cpus, hostname, networkInterfaces, platform, release, totalmem, uptime, } from "node:os";
function safeDeviceValue(value) {
    const normalized = value.trim();
    if (!normalized || normalized.length > 256 || /[\u0000-\u001f\u007f]/.test(normalized)) {
        return null;
    }
    return normalized;
}
async function optionalText(path) {
    try {
        return safeDeviceValue(await readFile(path, "utf8"));
    }
    catch (error) {
        if (typeof error === "object" &&
            error !== null &&
            "code" in error &&
            error.code === "ENOENT") {
            return null;
        }
        throw error;
    }
}
async function collectBlockDevices() {
    if (platform() !== "linux") {
        return [];
    }
    const names = (await readdir("/sys/block")).sort().slice(0, 64);
    return Promise.all(names.map(async (name) => {
        if (!/^[A-Za-z0-9._+-]{1,128}$/.test(name)) {
            throw new TypeError("Block device name is invalid");
        }
        const base = `/sys/block/${name}`;
        const sizeSectors = await optionalText(`${base}/size`);
        const removable = await optionalText(`${base}/removable`);
        const rotational = await optionalText(`${base}/queue/rotational`);
        const size = sizeSectors === null ? null : Number(sizeSectors);
        const sizeBytes = size !== null && Number.isSafeInteger(size) ? size * 512 : null;
        return {
            name,
            sizeBytes: sizeBytes !== null && Number.isSafeInteger(sizeBytes) && sizeBytes >= 0
                ? sizeBytes
                : null,
            removable: removable === "0" || removable === "1"
                ? removable === "1"
                : null,
            rotational: rotational === "0" || rotational === "1"
                ? rotational === "1"
                : null,
            model: await optionalText(`${base}/device/model`),
            vendor: await optionalText(`${base}/device/vendor`),
        };
    }));
}
export async function collectHostInventory(metrics) {
    const cpuInfo = cpus();
    const interfaces = networkInterfaces();
    return {
        schemaVersion: 1,
        hostname: hostname(),
        platform: platform(),
        release: release(),
        architecture: arch(),
        uptimeSeconds: Math.floor(uptime()),
        cpu: {
            count: cpuInfo.length,
            models: [
                ...new Set(cpuInfo
                    .map((cpu) => safeDeviceValue(cpu.model))
                    .filter((model) => model !== null)),
            ].slice(0, 16),
        },
        memoryTotalBytes: totalmem(),
        networkInterfaces: Object.entries(interfaces)
            .sort(([left], [right]) => left.localeCompare(right))
            .slice(0, 64)
            .map(([name, addresses]) => ({
            name: safeDeviceValue(name) ?? "unknown",
            mac: addresses?.find((address) => address.mac)?.mac ?? null,
            internal: addresses?.every((address) => address.internal) ?? true,
            addresses: (addresses ?? []).slice(0, 32).map((address) => ({
                address: address.address,
                family: address.family,
                netmask: address.netmask,
                cidr: address.cidr,
                internal: address.internal,
            })),
        })),
        blockDevices: await collectBlockDevices(),
        filesystems: metrics.os.filesystems,
    };
}
