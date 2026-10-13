const tokenPattern = /^[A-Za-z0-9_-]{43}$/;

export interface AgentConfig {
  monitorBaseUrl: string;
  enrollmentToken?: string;
  stateFilePath: string;
  heartbeatIntervalSeconds: number;
  serviceUnits: string[];
}

function requiredString(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function positiveInteger(
  environment: NodeJS.ProcessEnv,
  name: string,
  defaultValue: number,
): number {
  const value = Number(environment[name] ?? defaultValue);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function optionalServiceUnits(environment: NodeJS.ProcessEnv): string[] {
  const value = environment.XGS_MONITOR_SERVICES?.trim();
  if (!value) {
    return [];
  }

  const units = value.split(",").map((unit) => unit.trim());
  if (
    units.length > 19 ||
    units.some(
      (unit) =>
        !/^[A-Za-z0-9_.@:-]{1,128}\.service$/.test(unit),
    ) ||
    new Set(units).size !== units.length
  ) {
    throw new Error(
      "XGS_MONITOR_SERVICES must be a comma-separated list of up to 19 unique systemd service units",
    );
  }
  return units;
}

export function loadAgentConfig(environment: NodeJS.ProcessEnv): AgentConfig {
  const urlValue = requiredString(environment, "XGS_MONITOR_URL");
  let monitorUrl: URL;
  try {
    monitorUrl = new URL(urlValue);
  } catch {
    throw new Error("XGS_MONITOR_URL must be an absolute HTTPS URL");
  }

  if (
    monitorUrl.protocol !== "https:" ||
    monitorUrl.username ||
    monitorUrl.password ||
    monitorUrl.search ||
    monitorUrl.hash
  ) {
    throw new Error(
      "XGS_MONITOR_URL must be an HTTPS URL without credentials or query",
    );
  }

  const enrollmentToken = environment.XGS_MONITOR_ENROLLMENT_TOKEN?.trim();
  if (enrollmentToken && !tokenPattern.test(enrollmentToken)) {
    throw new Error("XGS_MONITOR_ENROLLMENT_TOKEN has an invalid format");
  }

  return {
    monitorBaseUrl: monitorUrl.toString().replace(/\/+$/, ""),
    enrollmentToken: enrollmentToken || undefined,
    stateFilePath:
      environment.XGS_MONITOR_AGENT_STATE_FILE?.trim() ||
      "/var/lib/xgs-monitor-agent/credentials.json",
    heartbeatIntervalSeconds: positiveInteger(
      environment,
      "XGS_MONITOR_HEARTBEAT_INTERVAL_SECONDS",
      60,
    ),
    serviceUnits: optionalServiceUnits(environment),
  };
}
