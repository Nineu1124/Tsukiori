import assert from "node:assert/strict";
import test from "node:test";
import { reconcileCrash, sameProcessIdentity } from "./lib.mjs";

test("process identity rejects stale PID fingerprints", () => {
  const actual = { pid: 42, startedAt: 1000, executable: "C:\\Program Files\\nodejs\\node.exe" };
  assert.equal(sameProcessIdentity(actual, { ...actual }), true);
  assert.equal(sameProcessIdentity(actual, { ...actual, startedAt: 1001 }), false);
  assert.equal(sameProcessIdentity(actual, { ...actual, executable: "C:\\Windows\\other.exe" }), false);
});

test("crash reconciliation distinguishes GUI, daemon, and runtime failure", () => {
  assert.equal(
    reconcileCrash({ guiAlive: false, daemonAlive: true, runtimeAlive: true }),
    "gui_down_control_and_runtime_alive",
  );
  assert.equal(
    reconcileCrash({ guiAlive: true, daemonAlive: false, runtimeAlive: true }),
    "daemon_down_runtime_orphaned",
  );
  assert.equal(
    reconcileCrash({ guiAlive: true, daemonAlive: true, runtimeAlive: false }),
    "runtime_exited_daemon_alive",
  );
});
