import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { JsonlClient, resolveCodexLaunch, sanitizeEvent } from "./jsonl-client.mjs";

const root = resolve(import.meta.dirname, "..", "..");
const privateRoot = join(root, "artifacts", "private", "t0.2");
const schemaRoot = join(privateRoot, "schema");
const fixtureRoot = join(root, "tests", "fixtures", "codex", "0.146.0");
const timeoutMs = 180_000;
const approvals = [];

function approvalHandler(label) {
  return async (method, params) => {
    approvals.push({ label, method, params });
    if (method === "item/commandExecution/requestApproval") return { decision: "decline" };
    if (method === "item/fileChange/requestApproval") return { decision: "decline" };
    if (method === "item/permissions/requestApproval") {
      return { permissions: { fileSystem: null, network: null }, scope: "turn" };
    }
    throw new Error("unsupported server request: " + method);
  };
}

async function startThread(client, cwd, sandbox = "workspace-write", approvalPolicy = "on-request") {
  const response = await client.request("thread/start", {
    cwd, sandbox, approvalPolicy, approvalsReviewer: "user", ephemeral: false,
  });
  return response.thread;
}

async function runTurn(client, threadId, text, { interrupt = false } = {}) {
  const response = await client.request("turn/start", {
    threadId,
    input: [{ type: "text", text }],
  });
  const turnId = response.turn.id;
  await client.waitFor("turn/started", (p) => p.threadId === threadId && p.turn?.id === turnId, timeoutMs);
  if (interrupt) await client.request("turn/interrupt", { threadId, turnId });
  const completed = await client.waitFor(
    "turn/completed",
    (p) => p.threadId === threadId && p.turn?.id === turnId,
    timeoutMs,
  );
  return completed.turn;
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

async function main() {
  await mkdir(privateRoot, { recursive: true });
  await mkdir(fixtureRoot, { recursive: true });
  const fixture = await mkdtemp(join(tmpdir(), "tsukiori-t02-"));
  const fixtureA = join(fixture, "handle-a");
  const fixtureB = join(fixture, "handle-b");
  await mkdir(fixtureA);
  await mkdir(fixtureB);
  for (const cwd of [fixtureA, fixtureB]) {
    execFileSync("git", ["init", "-q", "--initial-branch=main"], { cwd });
    await writeFile(join(cwd, "README.md"), "isolated Codex protocol fixture\n", "utf8");
  }

  const clients = [];
  try {
    const handleA = new JsonlClient({
      label: "handle-a", cwd: fixtureA, requestHandler: approvalHandler("handle-a"), timeoutMs,
    });
    const handleB = new JsonlClient({
      label: "handle-b", cwd: fixtureB, requestHandler: approvalHandler("handle-b"), timeoutMs,
    });
    clients.push(handleA, handleB);
    const [initA, initB] = await Promise.all([handleA.start(), handleB.start()]);
    const [accountA, accountB] = await Promise.all([
      handleA.request("account/read", { refreshToken: false }),
      handleB.request("account/read", { refreshToken: false }),
    ]);
    const [threadA, threadB] = await Promise.all([
      startThread(handleA, fixtureA),
      startThread(handleB, fixtureB),
    ]);

    const [turnA, turnB] = await Promise.all([
      runTurn(handleA, threadA.id, "Reply with the single token TSUKIORI_HANDLE_A. Do not use tools."),
      runTurn(handleB, threadB.id, "Reply with the single token TSUKIORI_HANDLE_B. Do not use tools."),
    ]);
    const leakedA = handleA.notifications.some((event) => event.params?.threadId === threadB.id);
    const leakedB = handleB.notifications.some((event) => event.params?.threadId === threadA.id);
    if (leakedA || leakedB) throw new Error("runtime handle event streams crossed");

    const [commandThread, fileThread, networkThread] = await Promise.all([
      startThread(handleA, fixtureA, "read-only", "on-request"),
      startThread(handleA, fixtureA, "read-only", "on-request"),
      startThread(handleB, fixtureB, "workspace-write", "on-request"),
    ]);
    await Promise.all([
      runTurn(
        handleA,
        commandThread.id,
        "Use only the shell to create approval-command-probe.txt in the current directory. Do not bypass an approval denial.",
      ),
      runTurn(
        handleA,
        fileThread.id,
        "Use the apply_patch file editing tool, not the shell, to create approval-file-probe.txt containing probe. Do not bypass an approval denial.",
      ),
      runTurn(
        handleB,
        networkThread.id,
        "Use the shell to make one HTTP HEAD request to https://example.com and no other host. Do not bypass an approval denial.",
      ),
    ]);

    const interruptThread = await startThread(handleB, fixtureB, "workspace-write", "never");
    const interruptedTurn = await runTurn(
      handleB,
      interruptThread.id,
      "Use the shell to run: powershell -NoProfile -Command Start-Sleep -Seconds 30. Then reply done.",
      { interrupt: true },
    );

    await handleB.stop();
    const resumed = new JsonlClient({
      label: "handle-b-resumed", cwd: fixtureB, requestHandler: approvalHandler("handle-b-resumed"), timeoutMs,
    });
    clients.push(resumed);
    await resumed.start();
    const resumeResponse = await resumed.request("thread/resume", { threadId: interruptThread.id });
    const resumedTurn = await runTurn(
      resumed,
      interruptThread.id,
      "Reply with the single token TSUKIORI_RESUMED. Do not use tools.",
    );

    const schemaPath = join(schemaRoot, "codex_app_server_protocol.schemas.json");
    const schema = await readFile(schemaPath);
    const aliases = new Map();
    const events = [
      ...handleA.notifications.map((e) => ({ handle: "A", ...sanitizeEvent(e, aliases) })),
      ...handleB.notifications.map((e) => ({ handle: "B", ...sanitizeEvent(e, aliases) })),
      ...resumed.notifications.map((e) => ({ handle: "B-resumed", ...sanitizeEvent(e, aliases) })),
    ].filter((e) => /^(thread|turn|item)\//.test(e.method));
    const scenarioFor = (threadId) => {
      if (threadId === commandThread.id) return "command";
      if (threadId === fileThread.id) return "file";
      if (threadId === networkThread.id) return "network";
      return "other";
    };
    const sanitizedApprovals = approvals.map((e) =>
      sanitizeEvent({ scenario: scenarioFor(e.params?.threadId), ...e }, aliases)
    );
    const methods = [...new Set(events.map((e) => e.method))].sort();
    const approvalMethods = [...new Set(sanitizedApprovals.map((e) => e.method))].sort();
    const approvalCoverage = {
      command: approvals.some((e) =>
        e.method === "item/commandExecution/requestApproval" &&
        e.params?.threadId === commandThread.id &&
        !e.params?.networkApprovalContext
      ),
      file: approvals.some((e) =>
        e.method === "item/fileChange/requestApproval" &&
        e.params?.threadId === fileThread.id
      ),
      networkScenarioIntercepted: approvals.some((e) =>
        e.params?.threadId === networkThread.id
      ),
      networkStructured: approvals.some((e) =>
        e.params?.threadId === networkThread.id &&
        (
          Boolean(e.params?.networkApprovalContext) ||
          Boolean(e.params?.proposedNetworkPolicyAmendments?.length) ||
          Boolean(e.params?.permissions?.network)
        )
      ),
    };
    const result = {
      codexVersion: (() => { const launch = resolveCodexLaunch(); return execFileSync(launch.command, [...launch.args, "--version"], { encoding: "utf8" }).trim(); })(),
      initialized: Boolean(initA?.userAgent && initB?.userAgent),
      authenticated: Boolean(accountA?.account && accountB?.account),
      handlesIndependent: !leakedA && !leakedB,
      lifecycle: {
        threadIdsDistinct: threadA.id !== threadB.id,
        turnAStatus: turnA.status,
        turnBStatus: turnB.status,
        itemEventsObserved: methods.includes("item/started") && methods.includes("item/completed"),
      },
      approvalMethods,
      approvalCoverage,
      interruptStatus: interruptedTurn.status,
      resumedThreadMatches: resumeResponse.thread.id === interruptThread.id,
      resumedTurnStatus: resumedTurn.status,
      schemaSha256: sha256(schema),
      schemaBytes: schema.length,
      observedMethods: methods,
    };
    await writeFile(join(privateRoot, "result.json"), JSON.stringify(result, null, 2) + "\n", "utf8");
    await writeFile(
      join(fixtureRoot, "app-server.sanitized.jsonl"),
      [...events, ...sanitizedApprovals].map((e) => JSON.stringify(e)).join("\n") + "\n",
      "utf8",
    );
    await writeFile(
      join(fixtureRoot, "schema-manifest.json"),
      JSON.stringify({
        codexVersion: result.codexVersion,
        experimental: false,
        sha256: result.schemaSha256,
        bytes: result.schemaBytes,
      }, null, 2) + "\n",
      "utf8",
    );
    await cp(schemaPath, join(fixtureRoot, "codex_app_server_protocol.schemas.json"));
    await writeFile(
      join(fixtureRoot, "result.sanitized.json"),
      JSON.stringify(result, null, 2) + "\n",
      "utf8",
    );
    const requiredChecks = [
      result.initialized,
      result.authenticated,
      result.handlesIndependent,
      result.lifecycle.threadIdsDistinct,
      result.lifecycle.turnAStatus === "completed",
      result.lifecycle.turnBStatus === "completed",
      result.lifecycle.itemEventsObserved,
      result.approvalCoverage.command,
      result.approvalCoverage.file,
      result.approvalCoverage.networkScenarioIntercepted,
      result.interruptStatus === "interrupted",
      result.resumedThreadMatches,
      result.resumedTurnStatus === "completed",
    ];
    if (!requiredChecks.every(Boolean)) throw new Error("T0.2 required protocol checks did not all pass");
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } finally {
    await Promise.allSettled(clients.map((client) => client.stop()));
    await rm(fixture, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write((error?.stack ?? String(error)) + "\n");
  process.exitCode = 1;
});
