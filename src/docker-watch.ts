import { execFile } from "node:child_process";

const INSPECT_CONCURRENCY = 10;
const INSPECT_FORMAT =
  "{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}|{{.RestartCount}}";
export type DockerContainerHealth =
  | "none"
  | "starting"
  | "healthy"
  | "unhealthy"
  | null;

export interface DockerContainerSnapshot {
  name: string;
  state: "running" | "stopped" | "unhealthy" | "missing";
  healthStatus: DockerContainerHealth;
  restartCount: number;
}

export interface DockerInspectResult {
  status: number | null;
  stdout: string;
  stderr: string;
  errorCode?: string;
}

export class DockerWatchCollectionError extends Error {
  constructor(readonly errorCode: string) {
    super(errorCode);
    this.name = "DockerWatchCollectionError";
  }
}

export function parseDockerInspectResult(
  name: string,
  result: DockerInspectResult,
): DockerContainerSnapshot {
  if (result.errorCode) {
    const errorCode =
      result.errorCode === "ENOENT"
        ? "docker_cli_unavailable"
        : result.errorCode === "ETIMEDOUT"
          ? "docker_command_timeout"
          : "docker_command_failed";
    throw new DockerWatchCollectionError(errorCode);
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
    throw new DockerWatchCollectionError("docker_daemon_unavailable");
  }

  const fields = result.stdout.trim().split("|");
  const dockerState = fields[0];
  const healthValue = fields[1];
  const restartCount = Number(fields[2]);
  if (
    fields.length !== 3 ||
    typeof dockerState !== "string" ||
    !/^[a-z]+$/.test(dockerState) ||
    !["none", "starting", "healthy", "unhealthy"].includes(healthValue ?? "") ||
    !Number.isSafeInteger(restartCount) ||
    restartCount < 0
  ) {
    throw new DockerWatchCollectionError("docker_inspect_invalid_response");
  }

  const healthStatus =
    healthValue === "none" ||
    healthValue === "starting" ||
    healthValue === "healthy" ||
    healthValue === "unhealthy"
      ? healthValue
      : null;
  return {
    name,
    state:
      dockerState === "running"
        ? healthStatus === "unhealthy"
          ? "unhealthy"
          : "running"
        : "stopped",
    healthStatus,
    restartCount,
  };
}

function runDockerInspect(name: string): Promise<DockerInspectResult> {
  return new Promise((resolve) => {
    execFile(
      "docker",
      ["container", "inspect", "--format", INSPECT_FORMAT, name],
      {
        encoding: "utf8",
        timeout: 5_000,
        maxBuffer: 4_096,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const errorCode =
          error && typeof error.code === "string" ? error.code : undefined;
        const status =
          error && typeof error.code === "number"
            ? error.code
            : error
              ? null
              : 0;
        resolve({
          status,
          stdout,
          stderr,
          ...(errorCode ? { errorCode } : {}),
        });
      },
    );
  });
}

export async function inspectDockerContainer(
  name: string,
): Promise<DockerContainerSnapshot> {
  const result = await runDockerInspect(name);
  return parseDockerInspectResult(name, result);
}

export async function collectDockerContainerSnapshots(
  names: readonly string[],
  inspect: (name: string) => Promise<DockerContainerSnapshot> =
    inspectDockerContainer,
): Promise<
  | { available: true; containers: DockerContainerSnapshot[] }
  | { available: false; errorCode: string; containers: [] }
> {
  const uniqueNames = new Set<string>();
  const containers: DockerContainerSnapshot[] = [];
  try {
    for (const name of names) {
      if (
        !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(name) ||
        uniqueNames.has(name)
      ) {
        throw new TypeError("Invalid Docker watch policy container name");
      }
      uniqueNames.add(name);
    }
    for (let offset = 0; offset < names.length; offset += INSPECT_CONCURRENCY) {
      containers.push(
        ...(await Promise.all(
          names
            .slice(offset, offset + INSPECT_CONCURRENCY)
            .map((name) => inspect(name)),
        )),
      );
    }
  } catch (error) {
    if (error instanceof DockerWatchCollectionError) {
      return { available: false, errorCode: error.errorCode, containers: [] };
    }
    throw error;
  }
  return { available: true, containers };
}
