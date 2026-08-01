import { setTimeout as delay } from "node:timers/promises";

export function sameProcessIdentity(expected, actual) {
  return Boolean(
    expected &&
    actual &&
    expected.pid === actual.pid &&
    expected.startedAt === actual.startedAt &&
    expected.executable.toLowerCase() === actual.executable.toLowerCase()
  );
}

export function reconcileCrash({ guiAlive, daemonAlive, runtimeAlive }) {
  if (!guiAlive && daemonAlive) {
    return runtimeAlive ? "gui_down_control_and_runtime_alive" : "gui_down_runtime_exited";
  }
  if (!daemonAlive && runtimeAlive) return "daemon_down_runtime_orphaned";
  if (daemonAlive && !runtimeAlive) return "runtime_exited_daemon_alive";
  if (!daemonAlive && !runtimeAlive) return "control_and_runtime_down";
  return "healthy";
}

export async function waitFor(predicate, { timeoutMs = 10_000, intervalMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await delay(intervalMs);
  }
  throw new Error("condition timed out after " + timeoutMs + "ms");
}
