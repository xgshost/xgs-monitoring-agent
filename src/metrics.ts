import { readFileSync, readdirSync, statfsSync, existsSync } from "node:fs";
import { cpus, loadavg, platform, release, totalmem, uptime } from "node:os";
import { spawnSync } from "node:child_process";

const MAX_FILESYSTEMS = 40;
const MAX_BLOCK_DEVICES = 32;
const PSEUDO_FILESYSTEMS = new Set([
  "autofs",
  "cgroup",
  "cgroup2",
  "configfs",
  "debugfs",
  "devpts",
  "devtmpfs",
  "fusectl",
  "mqueue",
  "overlay",
  "proc",
  "pstore",
  "securityfs",
  "sysfs",
  "tmpfs",
  "tracefs",
]);
const SERVICE_STATES = new Set([
  "active",
  "activating",
  "deactivating",
  "failed",
  "inactive",
  "maintenance",
  "unknown",
]);

export interface FilesystemMetric {
  mountPoint: string;
  filesystem: string;
  totalBytes: number;
  usedBytes: number;
  availableBytes: number;
  usedPercent: number;
  totalInodes: number | null;
  usedInodesPercent: number | null;
}

export interface ServiceMetric {
  name: string;
  state: string;
}

export interface AgentMetrics {
  schemaVersion: 1;
  agentVersion: string;
  sampledAtMs: number;
  os: {
    platform: string;
    release: string;
    uptimeSeconds: number;
    loadAverage: [number, number, number];
    cpuUsagePercent: number;
    memory: {
      totalBytes: number;
      usedBytes: number;
      availableBytes: number;
      usedPercent: number;
      swapTotalBytes: number;
      swapUsedBytes: number;
      swapUsedPercent: number;
    };
    filesystems: FilesystemMetric[];
  };
  hardware: {
    cpuModel: string;
    logicalCpuCount: number;
    memoryTotalBytes: number;
    blockDevices: Array<{
      name: string;
      model: string;
      sizeBytes: number;
    }>;
  };
  general: {
    bootId: string;
    docker: ServiceMetric;
    services: ServiceMetric[];
  };
}

interface CpuCounters {
  total: number;
  idle: number;
}

export function parseCpuCounters(contents: string): CpuCounters {
  const line = contents.split(/\r?\n/).find((entry) => /^cpu\s/.test(entry));
  if (!line) {
    throw new Error("CPU counters are missing from /proc/stat");
  }

  const values = line
    .trim()
    .split(/\s+/)
    .slice(1)
    .map(Number);
  if (
    values.length < 4 ||
    values.some((value) => !Number.isSafeInteger(value) || value < 0)
  ) {
    throw new Error("CPU counters in /proc/stat are invalid");
  }

  return {
    total: values.slice(0, 8).reduce((sum, value) => sum + value, 0),
    idle: values[3] + (values[4] ?? 0),
  };
}

export function cpuUsagePercent(
  before: CpuCounters,
  after: CpuCounters,
): number {
  const totalDelta = after.total - before.total;
  const idleDelta = after.idle - before.idle;
  if (
    !Number.isSafeInteger(totalDelta) ||
    !Number.isSafeInteger(idleDelta) ||
    totalDelta < 1 ||
    idleDelta < 0 ||
    idleDelta > totalDelta
  ) {
    throw new Error("CPU counter delta is invalid");
  }
  return Number((((totalDelta - idleDelta) / totalDelta) * 100).toFixed(2));
}

export function parseMemoryInfo(contents: string): {
  totalBytes: number;
  availableBytes: number;
  swapTotalBytes: number;
  swapAvailableBytes: number;
} {
  const values = new Map<string, number>();
  for (const line of contents.split(/\r?\n/)) {
    const match = /^([A-Za-z][A-Za-z0-9_()]*):\s+(\d+)\s+kB$/.exec(line);
    if (match) {
      values.set(match[1], Number(match[2]) * 1024);
    }
  }

  const totalBytes = values.get("MemTotal");
  const availableBytes = values.get("MemAvailable");
  const swapTotalBytes = values.get("SwapTotal");
  const swapAvailableBytes = values.get("SwapFree");
  if (
    totalBytes === undefined ||
    availableBytes === undefined ||
    swapTotalBytes === undefined ||
    swapAvailableBytes === undefined ||
    [totalBytes, availableBytes, swapTotalBytes, swapAvailableBytes].some(
      (value) => !Number.isSafeInteger(value) || value < 0,
    ) ||
    availableBytes > totalBytes ||
    swapAvailableBytes > swapTotalBytes
  ) {
    throw new Error("Required memory counters in /proc/meminfo are invalid");
  }

  return { totalBytes, availableBytes, swapTotalBytes, swapAvailableBytes };
}

function decodeMountField(value: string): string {
  return value.replace(/\\([0-7]{3})/g, (_, octal: string) =>
    String.fromCharCode(Number.parseInt(octal, 8)),
  );
}

export function parseMountInfo(contents: string): Array<{
  mountPoint: string;
  filesystem: string;
}> {
  const mounts = new Map<string, string>();
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
    const mountPoint = decodeMountField(beforeSeparator[4] ?? "");
    const filesystem = afterSeparator[0] ?? "";
    if (
      !mountPoint.startsWith("/") ||
      !filesystem ||
      PSEUDO_FILESYSTEMS.has(filesystem) ||
      mounts.has(mountPoint)
    ) {
      continue;
    }
    mounts.set(mountPoint, filesystem);
  }

  return Array.from(mounts, ([mountPoint, filesystem]) => ({
    mountPoint,
    filesystem,
  }))
    .sort((left, right) => left.mountPoint.localeCompare(right.mountPoint))
    .slice(0, MAX_FILESYSTEMS);
}

function toSafeNumber(value: bigint, label: string): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(`${label} is outside the supported numeric range`);
  }
  return Number(value);
}

function collectFilesystems(): FilesystemMetric[] {
  const mounts = parseMountInfo(readFileSync("/proc/self/mountinfo", "utf8"));
  const filesystems: FilesystemMetric[] = [];

  for (const mount of mounts) {
    try {
      const stats = statfsSync(mount.mountPoint, { bigint: true });
      const totalBytesBig = stats.blocks * stats.bsize;
      const availableBytesBig = stats.bavail * stats.bsize;
      const usedBytesBig = totalBytesBig - availableBytesBig;
      const totalBytes = toSafeNumber(totalBytesBig, "Filesystem size");
      const availableBytes = toSafeNumber(
        availableBytesBig,
        "Filesystem available space",
      );
      const usedBytes = toSafeNumber(usedBytesBig, "Filesystem used space");
      const totalInodesBig = stats.files;
      const freeInodesBig = stats.ffree;
      const totalInodes =
        totalInodesBig > 0n
          ? toSafeNumber(totalInodesBig, "Filesystem inode count")
          : null;
      const usedInodesPercent =
        totalInodes !== null
          ? Number(
              (
                ((totalInodesBig - freeInodesBig) * 100n * 100n) /
                totalInodesBig
              )
                .toString(),
            ) / 100
          : null;

      filesystems.push({
        mountPoint: mount.mountPoint,
        filesystem: mount.filesystem,
        totalBytes,
        usedBytes,
        availableBytes,
        usedPercent:
          totalBytes === 0
            ? 0
            : Number(((usedBytes / totalBytes) * 100).toFixed(2)),
        totalInodes,
        usedInodesPercent,
      });
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error.code === "ENOENT" ||
          error.code === "EACCES" ||
          error.code === "EPERM" ||
          error.code === "ENOTDIR")
      ) {
        continue;
      }
      throw error;
    }
  }

  return filesystems;
}

function readOptionalFile(filePath: string): string | undefined {
  try {
    return readFileSync(filePath, "utf8").trim();
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return undefined;
    }
    throw error;
  }
}

function collectBlockDevices(): AgentMetrics["hardware"]["blockDevices"] {
  const blockDirectory = "/sys/block";
  const excludedNames = /^(loop|ram|zram|dm-|md)/;
  return readdirSync(blockDirectory)
    .filter((name) => !excludedNames.test(name))
    .slice(0, MAX_BLOCK_DEVICES)
    .flatMap((name) => {
      const sectors = readOptionalFile(`${blockDirectory}/${name}/size`);
      if (!sectors || !/^\d+$/.test(sectors)) {
        return [];
      }
      const model =
        readOptionalFile(`${blockDirectory}/${name}/device/model`) ?? name;
      return [
        {
          name,
          model: model.slice(0, 128),
          sizeBytes: toSafeNumber(BigInt(sectors) * 512n, "Block device size"),
        },
      ];
    });
}

function serviceState(name: string): string {
  const result = spawnSync("systemctl", ["is-active", name], {
    encoding: "utf8",
    timeout: 2_000,
    windowsHide: true,
  });
  const state = result.stdout.trim();
  if (SERVICE_STATES.has(state)) {
    return state;
  }
  return "unknown";
}

function dockerServiceInstalled(): boolean {
  return [
    "/etc/systemd/system/docker.service",
    "/lib/systemd/system/docker.service",
    "/usr/lib/systemd/system/docker.service",
  ].some(existsSync);
}

function agentVersion(): string {
  const parsed: unknown = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("version" in parsed) ||
    typeof parsed.version !== "string" ||
    parsed.version.length < 1 ||
    parsed.version.length > 32
  ) {
    throw new Error("Agent package version is invalid");
  }
  return parsed.version;
}

async function measureCpuUsage(): Promise<number> {
  const before = parseCpuCounters(readFileSync("/proc/stat", "utf8"));
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  const after = parseCpuCounters(readFileSync("/proc/stat", "utf8"));
  return cpuUsagePercent(before, after);
}

export async function collectAgentMetrics(
  configuredServices: readonly string[],
): Promise<AgentMetrics> {
  if (platform() !== "linux") {
    throw new Error("Host metrics collection is supported on Linux only");
  }

  const memoryInfo = parseMemoryInfo(readFileSync("/proc/meminfo", "utf8"));
  const memoryUsedBytes = memoryInfo.totalBytes - memoryInfo.availableBytes;
  const swapUsedBytes =
    memoryInfo.swapTotalBytes - memoryInfo.swapAvailableBytes;
  const cpuList = cpus();
  const averages = loadavg();
  if (
    averages.length !== 3 ||
    averages.some((value) => !Number.isFinite(value) || value < 0)
  ) {
    throw new Error("System load averages are invalid");
  }
  const hasDocker = dockerServiceInstalled();
  const units = new Set(configuredServices);
  if (hasDocker) {
    units.add("docker.service");
  }

  const cpuModel = cpuList[0]?.model.trim();
  if (!cpuModel) {
    throw new Error("CPU model is unavailable");
  }

  const bootId = readFileSync(
    "/proc/sys/kernel/random/boot_id",
    "utf8",
  ).trim();
  if (!/^[A-Fa-f0-9-]{16,64}$/.test(bootId)) {
    throw new Error("System boot ID is invalid");
  }

  return {
    schemaVersion: 1,
    agentVersion: agentVersion(),
    sampledAtMs: Date.now(),
    os: {
      platform: platform(),
      release: release(),
      uptimeSeconds: Math.floor(uptime()),
      loadAverage: [averages[0], averages[1], averages[2]],
      cpuUsagePercent: await measureCpuUsage(),
      memory: {
        totalBytes: memoryInfo.totalBytes,
        usedBytes: memoryUsedBytes,
        availableBytes: memoryInfo.availableBytes,
        usedPercent: Number(
          ((memoryUsedBytes / memoryInfo.totalBytes) * 100).toFixed(2),
        ),
        swapTotalBytes: memoryInfo.swapTotalBytes,
        swapUsedBytes,
        swapUsedPercent:
          memoryInfo.swapTotalBytes === 0
            ? 0
            : Number(
                (
                  (swapUsedBytes / memoryInfo.swapTotalBytes) *
                  100
                ).toFixed(2),
              ),
      },
      filesystems: collectFilesystems(),
    },
    hardware: {
      cpuModel: cpuModel.slice(0, 128),
      logicalCpuCount: cpuList.length,
      memoryTotalBytes: toSafeNumber(BigInt(totalmem()), "Physical memory"),
      blockDevices: collectBlockDevices(),
    },
    general: {
      bootId,
      docker: {
        name: "docker.service",
        state: hasDocker ? serviceState("docker.service") : "not-installed",
      },
      services: Array.from(units)
        .sort()
        .slice(0, 20)
        .map((name) => ({ name, state: serviceState(name) })),
    },
  };
}
