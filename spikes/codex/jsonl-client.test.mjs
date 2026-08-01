import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeEvent } from "./jsonl-client.mjs";

test("sanitizeEvent replaces identifiers deterministically", () => {
  const aliases = new Map();
  const one = sanitizeEvent({ method: "turn/started", params: { threadId: "abc", turnId: "def" } }, aliases);
  const two = sanitizeEvent({ method: "item/started", params: { threadId: "abc", itemId: "ghi" } }, aliases);
  assert.equal(one.params.threadId, "<threadId-1>");
  assert.equal(one.params.turnId, "<turnId-2>");
  assert.equal(two.params.threadId, "<threadId-1>");
  assert.equal(two.params.itemId, "<itemId-3>");
});

test("sanitizeEvent redacts prompt, path, command, and network data", () => {
  const result = sanitizeEvent({
    method: "item/commandExecution/requestApproval",
    params: {
      command: "secret command",
      cwd: "D:/private/source",
      reason: "full prompt",
      networkApprovalContext: { host: "example.com", protocol: "https" },
      proposedExecpolicyAmendment: ["curl.exe", "--head"],
    },
  });
  assert.equal(result.params.command, "<redacted>");
  assert.equal(result.params.cwd, "<redacted>");
  assert.equal(result.params.reason, "<redacted>");
  assert.equal(result.params.networkApprovalContext.host, "<redacted>");
  assert.equal(result.params.networkApprovalContext.protocol, "https");
  assert.deepEqual(result.params.proposedExecpolicyAmendment, ["<redacted>", "<redacted>"]);
});
