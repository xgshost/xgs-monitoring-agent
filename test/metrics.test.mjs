import assert from "node:assert/strict";
import test from "node:test";
import {
  cpuUsagePercent,
  parseCpuCounters,
  parseMemoryInfo,
  parseMountInfo,
} from "../dist/metrics.js";

test("parses aggregate CPU counters and calculates utilization", () => {
  const before = parseCpuCounters(
    "cpu 100 0 50 800 10 0 0 0 100 10\ncpu0 50 0 25 400 5 0 0 0 50 5\n",
  );
  const after = parseCpuCounters(
    "cpu 200 0 100 900 20 0 0 0 200 20\ncpu0 100 0 50 450 10 0 0 0 100 10\n",
  );

  assert.equal(cpuUsagePercent(before, after), 57.69);
});

test("rejects invalid or non-increasing CPU counters", () => {
  assert.throws(() => parseCpuCounters("cpu 1 nope 3 4\n"), /invalid/);
  assert.throws(
    () => cpuUsagePercent({ total: 10, idle: 8 }, { total: 10, idle: 8 }),
    /delta is invalid/,
  );
});

test("parses memory and swap counters from procfs", () => {
  assert.deepEqual(
    parseMemoryInfo(
      "MemTotal: 1024 kB\nMemAvailable: 256 kB\nSwapTotal: 512 kB\nSwapFree: 128 kB\n",
    ),
    {
      totalBytes: 1_048_576,
      availableBytes: 262_144,
      swapTotalBytes: 524_288,
      swapAvailableBytes: 131_072,
    },
  );
  assert.throws(
    () => parseMemoryInfo("MemTotal: 100 kB\nMemAvailable: 200 kB\n"),
    /invalid/,
  );
});

test("parses real mount points while excluding pseudo filesystems", () => {
  const mounts = parseMountInfo([
    "24 1 8:1 / / rw,relatime - ext4 /dev/sda1 rw",
    "25 1 8:1 /data /mnt/data\\040disk rw,relatime - ext4 /dev/sda1 rw",
    "26 1 0:5 / /proc rw,nosuid - proc proc rw",
  ].join("\n"));

  assert.deepEqual(mounts, [
    { mountPoint: "/", filesystem: "ext4" },
    { mountPoint: "/mnt/data disk", filesystem: "ext4" },
  ]);
});
