import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { join, resolve } from "node:path";

const fixture = resolve(import.meta.dirname, "..", "..", "tests", "fixtures", "windows");

test("Windows control-plane fixture hash and required checks are valid", async () => {
  const [content, expectedHash] = await Promise.all([
    readFile(join(fixture, "control-plane-result.json"), "utf8"),
    readFile(join(fixture, "control-plane-result.sha256"), "utf8"),
  ]);
  assert.equal(createHash("sha256").update(content).digest("hex"), expectedHash.trim());
  const result = JSON.parse(content);
  assert.equal(result.generatedAt, "<timestamp>");
  assert.equal(result.platform, "win32");
  assert.equal(result.architecture, "x64");
  assert.equal(result.allRequiredChecksPassed, true);
  assert.equal(result.pipe.currentUserOnly, true);
  assert.equal(result.pipe.reconnects, true);
  assert.equal(result.job.treeTerminatedOnJobClose, true);
  assert.equal(result.job.guardRejectedStaleIdentity, true);
  assert.equal(result.job.unrelatedSurvivedGuard, true);
  assert.equal(result.pty.directInteractive, true);
  assert.equal(result.pty.packagedInteractive, true);
  assert.equal(result.git.changeStatusObserved, true);
  assert.equal(result.git.removed, true);
  assert.equal(result.crash.expected, true);
  assert.match(result.pty.prebuiltSha256, /^[a-f0-9]{64}$/);
  const matrix = JSON.parse(await readFile(join(fixture, "capability-matrix.json"), "utf8"));
  assert.equal(matrix.capabilities.every((capability) => capability.supportLevel === "supported"), true);
  assert.equal(matrix.knownIssues.length, 3);
  assert.doesNotMatch(content, /S-1-5-|[A-Z]:\\Users\\|tsukiori-t03-|\\\\\.\\pipe\\/i);
});
