import { execFileSync } from "node:child_process";
import { isIP } from "node:net";
import { pathToFileURL } from "node:url";
import { loadAgentConfig } from "./config.js";
import { loadAgentState } from "./state.js";

const TABLE_NAME = "xgs_monitor_agent";
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_BAN_TTL_MS = 86_520_000;

export interface SshBanPolicy {
  enabled: boolean;
  revision: number;
  bans: Array<{ sourceIp: string; expiresAtMs: number }>;
}

type NftRunner = (args: string[], input?: string) => string;

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

function nftRunner(args: string[], input?: string): string {
  return execFileSync("nft", args, {
    encoding: "utf8",
    input,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function initialTableScript(ports: number[]): string {
  const portSet = `{ ${ports.join(", ")} }`;
  return [
    `add table inet ${TABLE_NAME}`,
    `add set inet ${TABLE_NAME} blocked_ipv4 { type ipv4_addr; flags timeout; }`,
    `add set inet ${TABLE_NAME} blocked_ipv6 { type ipv6_addr; flags timeout; }`,
    `add chain inet ${TABLE_NAME} ssh_input { type filter hook input priority -10; policy accept; }`,
    `add rule inet ${TABLE_NAME} ssh_input tcp dport ${portSet} ip saddr @blocked_ipv4 drop`,
    `add rule inet ${TABLE_NAME} ssh_input tcp dport ${portSet} ip6 saddr @blocked_ipv6 drop`,
    "",
  ].join("\n");
}

export function buildNftablesSyncScript(
  policy: SshBanPolicy,
  ports: number[],
  now: number,
): string {
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
    throw new TypeError("Invalid nftables sync inputs");
  }

  const ipv4 = new Map<string, number>();
  const ipv6 = new Map<string, number>();
  if (policy.enabled) {
    for (const ban of policy.bans) {
      if (ban.expiresAtMs <= now) {
        continue;
      }
      const sourceIp = canonicalIpAddress(ban.sourceIp);
      if (ban.expiresAtMs > now + MAX_BAN_TTL_MS) {
        throw new TypeError("Policy ban exceeds the maximum allowed duration");
      }
      const seconds = Math.max(
        1,
        Math.ceil((ban.expiresAtMs - now) / 1000),
      );
      (isIP(sourceIp) === 4 ? ipv4 : ipv6).set(sourceIp, seconds);
    }
  }

  const portSet = `{ ${[...ports].sort((a, b) => a - b).join(", ")} }`;
  const lines = [
    `flush set inet ${TABLE_NAME} blocked_ipv4`,
    `flush set inet ${TABLE_NAME} blocked_ipv6`,
    `flush chain inet ${TABLE_NAME} ssh_input`,
    `add rule inet ${TABLE_NAME} ssh_input tcp dport ${portSet} ip saddr @blocked_ipv4 drop`,
    `add rule inet ${TABLE_NAME} ssh_input tcp dport ${portSet} ip6 saddr @blocked_ipv6 drop`,
  ];
  for (const [address, seconds] of ipv4) {
    lines.push(
      `add element inet ${TABLE_NAME} blocked_ipv4 { ${address} timeout ${seconds}s }`,
    );
  }
  for (const [address, seconds] of ipv6) {
    lines.push(
      `add element inet ${TABLE_NAME} blocked_ipv6 { ${address} timeout ${seconds}s }`,
    );
  }
  return `${lines.join("\n")}\n`;
}

export function syncNftablesPolicy(
  policy: SshBanPolicy,
  ports: number[],
  now: number,
  runNft: NftRunner = nftRunner,
): number {
  const activeBanCount = policy.enabled
    ? policy.bans.filter((ban) => ban.expiresAtMs > now).length
    : 0;
  const tables = runNft(["list", "tables"]);
  const tableExists = tables
    .split("\n")
    .some((line) => line.trim() === `table inet ${TABLE_NAME}`);
  if (!tableExists && activeBanCount === 0) {
    return 0;
  }
  if (!tableExists) {
    runNft(["-f", "-"], initialTableScript(ports));
  }
  runNft(["-f", "-"], buildNftablesSyncScript(policy, ports, now));
  return activeBanCount;
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

function errorCode(error: unknown): string {
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
    count = syncNftablesPolicy(policy, ports, Date.now());
  } catch (error) {
    try {
      await reportPolicyStatus(config.monitorBaseUrl, state.agentToken, {
        policyRevision: policy.revision,
        status: "failed",
        activeBanCount: 0,
        errorCode: errorCode(error),
      });
    } catch (reportError) {
      console.error(
        "Could not report SSH firewall sync failure",
        errorCode(reportError),
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
    console.error("SSH firewall policy sync failed", errorCode(error));
    process.exitCode = 1;
  });
}
