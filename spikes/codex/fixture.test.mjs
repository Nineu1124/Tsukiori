import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { join, resolve } from "node:path";

const fixture = resolve(import.meta.dirname, "..", "..", "tests", "fixtures", "codex", "0.146.0");

test("committed schema matches its version-locked manifest", async () => {
  const [schema, manifestText] = await Promise.all([
    readFile(join(fixture, "codex_app_server_protocol.schemas.json")),
    readFile(join(fixture, "schema-manifest.json"), "utf8"),
  ]);
  const manifest = JSON.parse(manifestText);
  assert.equal(manifest.codexVersion, "codex-cli 0.146.0");
  assert.equal(manifest.experimental, false);
  assert.equal(schema.length, manifest.bytes);
  assert.equal(createHash("sha256").update(schema).digest("hex"), manifest.sha256);
  const methods = schema.toString("utf8");
  for (const method of [
    "initialize",
    "thread/start",
    "thread/resume",
    "turn/start",
    "turn/interrupt",
    "item/commandExecution/requestApproval",
    "item/fileChange/requestApproval",
    "item/permissions/requestApproval",
  ]) {
    assert.match(methods, new RegExp(method.replace("/", "\\/")));
  }
});

test("sanitized fixture proves lifecycle and approval boundaries without raw data", async () => {
  const text = await readFile(join(fixture, "app-server.sanitized.jsonl"), "utf8");
  const events = text.trim().split(/\r?\n/).map(JSON.parse);
  const methods = new Set(events.map((event) => event.method));
  for (const method of [
    "thread/started",
    "turn/started",
    "item/started",
    "item/completed",
    "turn/completed",
    "item/commandExecution/requestApproval",
    "item/fileChange/requestApproval",
  ]) {
    assert.equal(methods.has(method), true, "missing " + method);
  }
  assert.equal(events.some((event) => event.scenario === "command"), true);
  assert.equal(events.some((event) => event.scenario === "file"), true);
  assert.equal(events.some((event) => event.scenario === "network"), true);
  assert.doesNotMatch(text, /[A-Z]:\\Users\\|tsukiori-t02-|https:\/\/example\.com|curl\.exe|approval-(command|file)-probe/i);
});

test("sanitized result records verified checks and keeps structured network approval unknown", async () => {
  const result = JSON.parse(await readFile(join(fixture, "result.sanitized.json"), "utf8"));
  assert.equal(result.initialized, true);
  assert.equal(result.authenticated, true);
  assert.equal(result.handlesIndependent, true);
  assert.equal(result.lifecycle.turnAStatus, "completed");
  assert.equal(result.lifecycle.turnBStatus, "completed");
  assert.equal(result.lifecycle.itemEventsObserved, true);
  assert.equal(result.approvalCoverage.command, true);
  assert.equal(result.approvalCoverage.file, true);
  assert.equal(result.approvalCoverage.networkScenarioIntercepted, true);
  assert.equal(result.approvalCoverage.networkStructured, false);
  assert.equal(result.interruptStatus, "interrupted");
  assert.equal(result.resumedThreadMatches, true);
  assert.equal(result.resumedTurnStatus, "completed");
  const matrix = JSON.parse(await readFile(join(fixture, "capability-matrix.json"), "utf8"));
  const network = matrix.capabilities.find((capability) => capability.name === "structured_network_approval");
  assert.equal(network.supportLevel, "unknown");
  assert.equal(network.enforcementLevel, "unknown");
});
