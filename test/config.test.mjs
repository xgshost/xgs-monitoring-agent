import assert from "node:assert/strict";
import test from "node:test";
import { loadAgentConfig } from "../dist/config.js";

test("loads optional systemd service allowlist", () => {
  const config = loadAgentConfig({
    XGS_MONITOR_URL: "https://monitor.example.test",
    XGS_MONITOR_SERVICES: "nginx.service,pteroq.service",
  });

  assert.deepEqual(config.serviceUnits, ["nginx.service", "pteroq.service"]);
});

test("rejects invalid service names and duplicate units", () => {
  assert.throws(
    () =>
      loadAgentConfig({
        XGS_MONITOR_URL: "https://monitor.example.test",
        XGS_MONITOR_SERVICES: "nginx.service; reboot.service",
      }),
    /XGS_MONITOR_SERVICES/,
  );
  assert.throws(
    () =>
      loadAgentConfig({
        XGS_MONITOR_URL: "https://monitor.example.test",
        XGS_MONITOR_SERVICES: "nginx.service,nginx.service",
      }),
    /XGS_MONITOR_SERVICES/,
  );
});
