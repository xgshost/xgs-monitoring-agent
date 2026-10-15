import assert from "node:assert/strict";
import test from "node:test";
import {
  collectDockerContainerNames,
  collectDockerContainerSnapshots,
  DockerWatchCollectionError,
  parseDockerContainerListResult,
  parseDockerInspectResult,
} from "../dist/docker-watch.js";

test("parses name-only Docker inventory, including stopped containers", () => {
  assert.deepEqual(
    parseDockerContainerListResult({
      status: 0,
      stdout: "web\nworker\n",
      stderr: "",
    }),
    ["web", "worker"],
  );
  assert.deepEqual(
    parseDockerContainerListResult({ status: 0, stdout: "", stderr: "" }),
    [],
  );
});

test("rejects invalid Docker inventory and reports Docker access failures", async () => {
  assert.throws(
    () =>
      parseDockerContainerListResult({
        status: 0,
        stdout: "web\nbad/name\n",
        stderr: "",
      }),
    (error) =>
      error instanceof DockerWatchCollectionError &&
      error.errorCode === "docker_inventory_invalid_response",
  );
  assert.deepEqual(
    await collectDockerContainerNames(async () => ({
      status: 1,
      stdout: "",
      stderr: "Docker daemon unavailable",
    })),
    {
      available: false,
      errorCode: "docker_daemon_unavailable",
      containerNames: [],
    },
  );
});

test("parses running Docker containers without health checks", () => {
  assert.deepEqual(
    parseDockerInspectResult("web", {
      status: 0,
      stdout: "running|none|0\n",
      stderr: "",
    }),
    {
      name: "web",
      state: "running",
      healthStatus: "none",
      restartCount: 0,
    },
  );
});

test("reports stopped and unhealthy containers distinctly", () => {
  assert.equal(
    parseDockerInspectResult("worker", {
      status: 0,
      stdout: "exited|none|4\n",
      stderr: "",
    }).state,
    "stopped",
  );
  assert.equal(
    parseDockerInspectResult("api", {
      status: 0,
      stdout: "running|unhealthy|1\n",
      stderr: "",
    }).state,
    "unhealthy",
  );
});

test("distinguishes a missing container from Docker daemon failures", () => {
  assert.equal(
    parseDockerInspectResult("old-api", {
      status: 1,
      stdout: "",
      stderr: "Error: No such object: old-api",
    }).state,
    "missing",
  );
  assert.throws(
    () =>
      parseDockerInspectResult("api", {
        status: 1,
        stdout: "",
        stderr: "Cannot connect to the Docker daemon",
      }),
    (error) =>
      error instanceof DockerWatchCollectionError &&
      error.errorCode === "docker_daemon_unavailable",
  );
});

test("a Docker access failure discards partial results instead of reporting missing", async () => {
  const report = await collectDockerContainerSnapshots(
    ["web", "api"],
    async (name) => {
      if (name === "api") {
        throw new DockerWatchCollectionError("docker_daemon_unavailable");
      }
      return {
        name,
        state: "running",
        healthStatus: "none",
        restartCount: 0,
      };
    },
  );
  assert.deepEqual(report, {
    available: false,
    errorCode: "docker_daemon_unavailable",
    containers: [],
  });
});

test("rejects invalid policy container names before inspection", async () => {
  await assert.rejects(
    collectDockerContainerSnapshots(["bad/name"], async () => {
      throw new Error("must not inspect");
    }),
    /Invalid Docker watch policy container name/,
  );
});
