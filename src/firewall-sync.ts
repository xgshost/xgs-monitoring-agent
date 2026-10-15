import { execFileSync } from "node:child_process";
import { isIP } from "node:net";
import { pathToFileURL } from "node:url";
import { loadAgentConfig } from "./config.js";
import { loadAgentState } from "./state.js";

const FAIL2BAN_JAIL = "xgs-monitor-agent";
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_BAN_TTL_MS = 30 * 86_400_000 + 60_000;
const MAX_BANS_PER_BATCH = 100;

export interface SshBanPolicy {
  enabled: boolean;
  revision: number;
  bans: Array<{ sourceIp: string; expiresAtMs: number }>;
}

type Fail2banRunner = (args: string[]) => string;

function canonicalIpAddress(value: string): string {
  const version = isIP(value);
  if (version === 4) {
    return value.split(".").map((part) => String(Number(part))).join(".");
  }
  if (version === 6) {
    return new URL(`http://[${value}]`).hostname.slice(1, -1);
  }
  throw new TypeError("Policy contains an invalid IP address");
}

export function validateSshBanPolicy(
  value: unknown,
  now = Date.now(),
): SshBanPolicy {
  if (
    !Number.isSafeInteger(now) ||
    now < 1 ||
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !("status" in value) ||
    value.status !== "ok" ||
    !("enabled" in value) ||
    typeof value.enabled !== "boolean" ||
    !("revision" in value) ||
    typeof value.revision !== "number" ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 1 ||
    !("bans" in value) ||
    !Array.isArray(value.bans) ||
    value.bans.length > 10_000 ||
    Object.keys(value).some(
      (key) => !["status", "enabled", "revision", "bans"].includes(key),
    )
  ) {
    throw new TypeError("Central returned an invalid SSH ban policy");
  }

  const addresses = new Set<string>();
  const bans = value.bans.map((entry) => {
    if (
      typeof entry !== "object" ||
      entry === null ||
      Array.isArray(entry) ||
      Object.keys(entry).some(
        (key) => !["sourceIp", "expiresAtMs"].includes(key),
      ) ||
      !("sourceIp" in entry) ||
      typeof entry.sourceIp !== "string" ||
      !("expiresAtMs" in entry) ||
      typeof entry.expiresAtMs !== "number" ||
      !Number.isSafeInteger(entry.expiresAtMs) ||
      entry.expiresAtMs < 1 ||
      entry.expiresAtMs > now + MAX_BAN_TTL_MS
    ) {
      throw new TypeError("Central returned an invalid SSH ban");
    }
    const sourceIp = canonicalIpAddress(entry.sourceIp);
    if (addresses.has(sourceIp)) {
      throw new TypeError("Central returned duplicate SSH bans");
    }
    addresses.add(sourceIp);
    return { sourceIp, expiresAtMs: entry.expiresAtMs };
  });

  return {
    enabled: value.enabled,
    revision: value.revision,
    bans,
  };
}

export function parseSshPorts(value: string | undefined): number[] {
  if (!value?.trim()) {
    return [22];
  }
  const parts = value.split(",").map((part) => part.trim());
  const ports = parts.map(Number);
  if (
    parts.length > 32 ||
    parts.some((part) => !/^[0-9]{1,5}$/.test(part)) ||
    ports.some(
      (port) => !Number.isSafeInteger(port) || port < 1 || port > 65_535,
    ) ||
    new Set(ports).size !== ports.length
  ) {
    throw new TypeError(
      "XGS_MONITOR_SSH_PORTS must be a comma-separated list of up to 32 unique ports from 1 to 65535",
    );
  }
  return ports.sort((left, right) => left - right);
}

function fail2banRunner(args: string[]): string {
  return execFileSync("fail2ban-client", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 1024 * 1024,
  });
}

export function parseFail2banBanList(output: string): string[] {
  const trimmed = output.trim();
  if (!trimmed) {
    return [];
  }
  const addresses = trimmed.split(/[\s,]+/).map(canonicalIpAddress);
  return [...new Set(addresses)].sort();
}

function batches<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let offset = 0; offset < items.length; offset += size) {
    result.push(items.slice(offset, offset + size));
  }
  return result;
}

export function syncFail2banPolicy(
  policy: SshBanPolicy,
  ports: number[],
  now: number,
  runFail2ban: Fail2banRunner = fail2banRunner,
): number {
  if (
    !Number.isSafeInteger(now) ||
    now < 1 ||
    ports.length < 1 ||
    ports.length > 32 ||
    ports.some(
      (port) => !Number.isSafeInteger(port) || port < 1 || port > 65_535,
    ) ||
    new Set(ports).size !== ports.length
  ) {
    throw new TypeError("Invalid Fail2ban sync inputs");
  }

  const desired = new Set<string>();
  if (policy.enabled) {
    for (const ban of policy.bans) {
      if (ban.expiresAtMs <= now) {
        continue;
      }
      const sourceIp = canonicalIpAddress(ban.sourceIp);
      if (ban.expiresAtMs > now + MAX_BAN_TTL_MS) {
        throw new TypeError("Policy ban exceeds the maximum allowed duration");
      }
      desired.add(sourceIp);
    }
  }

  const current = new Set(
    parseFail2banBanList(
      runFail2ban(["get", FAIL2BAN_JAIL, "banip", ","]),
    ),
  );
  const toUnban = [...current].filter((address) => !desired.has(address));
  const toBan = [...desired].filter((address) => !current.has(address));

  for (const chunk of batches(toUnban, MAX_BANS_PER_BATCH)) {
    runFail2ban(["set", FAIL2BAN_JAIL, "unbanip", ...chunk]);
  }
  for (const chunk of batches(toBan, MAX_BANS_PER_BATCH)) {
    runFail2ban(["set", FAIL2BAN_JAIL, "banip", ...chunk]);
  }
  return desired.size;
}

async function fetchSshBanPolicy(
  monitorBaseUrl: string,
  agentToken: string,
): Promise<SshBanPolicy> {
  const response = await fetch(
    `${monitorBaseUrl}/api/v1/agents/ssh-ban-policy`,
    {
      headers: { authorization: `Bearer ${agentToken}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    },
  );
  if (!response.ok) {
    throw Object.assign(new Error("SSH ban policy request failed"), {
      statusCode: response.status,
    });
  }
  const body: unknown = await response.json();
  return validateSshBanPolicy(body);
}

export function firewallSyncErrorCode(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "statusCode" in error &&
    typeof error.statusCode === "number" &&
    Number.isSafeInteger(error.statusCode)
  ) {
    return `HTTP_${error.statusCode}`;
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    /^[A-Za-z0-9_.-]{1,64}$/.test(error.code)
  ) {
    return error.code;
  }
  const output = (key: "stdout" | "stderr"): string => {
    if (typeof error !== "object" || error === null) {
      return "";
    }
    let value: unknown;
    if (key === "stderr" && "stderr" in error) {
      value = error.stderr;
    } else if (key === "stdout" && "stdout" in error) {
      value = error.stdout;
    } else {
      return "";
    }
    return typeof value === "string"
      ? value
      : Buffer.isBuffer(value)
        ? value.toString("utf8")
        : "";
  };
  if (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    typeof error.status === "number" &&
    Number.isSafeInteger(error.status) &&
    error.status >= 0
  ) {
    const diagnostic = `${output("stderr")}\n${output("stdout")}`;
    if (/operation not permitted|permission denied/i.test(diagnostic)) {
      return "FAIL2BAN_PERMISSION_DENIED";
    }
    if (/no such jail|jail .* not found|unknown jail/i.test(diagnostic)) {
      return "FAIL2BAN_JAIL_MISSING";
    }
    if (
      /failed to communicate|connection refused|no such file or directory/i.test(
        diagnostic,
      )
    ) {
      return "FAIL2BAN_UNAVAILABLE";
    }
    const hasOutput =
      Boolean(output("stderr")) || Boolean(output("stdout"));
    return `FAIL2BAN_EXIT_${error.status}_${hasOutput ? "OUTPUT" : "NO_OUTPUT"}`;
  }
  return error instanceof Error ? error.name : "UNKNOWN";
}

async function reportPolicyStatus(
  monitorBaseUrl: string,
  agentToken: string,
  report: {
    policyRevision: number;
    status: "applied" | "failed";
    activeBanCount: number;
    errorCode?: string;
  },
): Promise<void> {
  const response = await fetch(
    `${monitorBaseUrl}/api/v1/agents/ssh-ban-status`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${agentToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(report),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    },
  );
  if (!response.ok) {
    throw Object.assign(new Error("SSH firewall status report was rejected"), {
      statusCode: response.status,
    });
  }
}

async function run(): Promise<void> {
  const config = loadAgentConfig(process.env);
  const state = loadAgentState(config.stateFilePath);
  if (!state.enrollmentAccepted) {
    throw new Error("Firewall sync requires a completed agent enrollment");
  }
  const policy = await fetchSshBanPolicy(
    config.monitorBaseUrl,
    state.agentToken,
  );
  let count: number;
  try {
    const ports = parseSshPorts(process.env.XGS_MONITOR_SSH_PORTS);
    count = syncFail2banPolicy(policy, ports, Date.now());
  } catch (error) {
    try {
      await reportPolicyStatus(config.monitorBaseUrl, state.agentToken, {
        policyRevision: policy.revision,
        status: "failed",
        activeBanCount: 0,
        errorCode: firewallSyncErrorCode(error),
      });
    } catch (reportError) {
      console.error(
        "Could not report SSH ban sync failure",
        firewallSyncErrorCode(reportError),
      );
    }
    throw error;
  }
  await reportPolicyStatus(config.monitorBaseUrl, state.agentToken, {
    policyRevision: policy.revision,
    status: "applied",
    activeBanCount: count,
  });
  console.info(
    `SSH firewall policy revision ${policy.revision} synchronized; ${count} active ban(s).`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  run().catch((error: unknown) => {
    console.error(
      "SSH ban policy sync failed",
      firewallSyncErrorCode(error),
    );
    process.exitCode = 1;
  });
}
