import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  reportAgentDebug,
  summarizeAgentMetrics,
} from "../dist/debug-reporting.js";

const state = {
  agentToken: "a".repeat(43),
  enrollmentAccepted: true,
  debugEnabled: true,
};
const metricsSummary = {
  sampledAtMs: 1_700_000_000_000,
  cpuUsagePercent: 12.5,
  memory: {
    usedBytes: 4_294_967_296,
    totalBytes: 8_589_934_592,
    usedPercent: 50,
  },
  rootFilesystem: {
    usedBytes: 10_737_418_240,
    totalBytes: 53_687_091_200,
    usedPercent: 20,
  },
};

test("sends only an allowlisted structured operation when debug mode is enabled", async () => {
  let requestedUrl;
  let requestOptions;
  await reportAgentDebug(
    "/tmp/agent-errors.jsonl",
    "https://monitor.example",
    state,
    "metrics_upload",
    async (url, options) => {
      requestedUrl = url;
      requestOptions = options;
      return new Response(null, { status: 202 });
    },
    metricsSummary,
  );

  assert.equal(
    requestedUrl,
    "https://monitor.example/api/v1/agents/debug-events",
  );
  assert.deepEqual(Object.keys(JSON.parse(requestOptions.body)).sort(), [
    "metrics",
    "occurredAtMs",
    "operation",
  ]);
  assert.equal(JSON.parse(requestOptions.body).operation, "metrics_upload");
  assert.deepEqual(JSON.parse(requestOptions.body).metrics, metricsSummary);
});

test("summarizes only CPU, memory, and root filesystem metrics", () => {
  assert.deepEqual(
    summarizeAgentMetrics({
      sampledAtMs: metricsSummary.sampledAtMs,
      os: {
        cpuUsagePercent: 12.5,
        memory: {
          usedBytes: metricsSummary.memory.usedBytes,
          totalBytes: metricsSummary.memory.totalBytes,
          usedPercent: 50,
        },
        filesystems: [
          {
            mountPoint: "/",
            filesystem: "ext4",
            usedBytes: metricsSummary.rootFilesystem.usedBytes,
            totalBytes: metricsSummary.rootFilesystem.totalBytes,
            availableBytes: 42_949_672_960,
            usedPercent: 20,
          },
          {
            mountPoint: "/customer-data",
            filesystem: "xfs",
            usedBytes: 1,
            totalBytes: 10,
            availableBytes: 9,
            usedPercent: 10,
          },
        ],
      },
    }),
    metricsSummary,
  );
});

test("does not report debug events when the server mode is disabled", async () => {
  let requestCount = 0;
  await reportAgentDebug(
    "/tmp/agent-errors.jsonl",
    "https://monitor.example",
    { ...state, debugEnabled: false },
    "metrics_upload",
    async () => {
      requestCount += 1;
      return new Response(null, { status: 202 });
    },
  );
  assert.equal(requestCount, 0);
});

test("forwards repeated identical agent errors without an application cooldown", async () => {
  let requestCount = 0;
  const directory = mkdtempSync(join(tmpdir(), "xgs-agent-debug-errors-"));
  const filePath = join(directory, "errors.jsonl");
  const request = async () => {
    requestCount += 1;
    return new Response(null, { status: 202 });
  };
  try {
    const { reportAgentError } = await import("../dist/error-reporting.js");
    await reportAgentError(
      filePath,
      "https://monitor.example",
      state,
      "heartbeat_upload",
      Object.assign(new Error("ignored"), { code: "ECONNREFUSED" }),
      request,
    );
    await reportAgentError(
      filePath,
      "https://monitor.example",
      state,
      "heartbeat_upload",
      Object.assign(new Error("ignored"), { code: "ECONNREFUSED" }),
      request,
    );
    assert.equal(requestCount, 2);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
