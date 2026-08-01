import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  access,
  appendFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { spawn } from "node:child_process";
import pty from "node-pty";
import { reconcileCrash, waitFor } from "./lib.mjs";

const execFileAsync = promisify(execFile);
const root = resolve(import.meta.dirname, "..", "..");
const privateRoot = join(root, "artifacts", "private", "t0.3");
const fixtureRoot = join(root, "tests", "fixtures", "windows");
const pipeScript = join(import.meta.dirname, "pipe-probe.ps1");
const jobScript = join(import.meta.dirname, "job-probe.ps1");

async function run(command, args, options = {}) {
  return execFileAsync(command, args, {
    cwd: options.cwd ?? root,
    encoding: "utf8",
    windowsHide: true,
    timeout: options.timeout ?? 60_000,
    maxBuffer: 4 * 1024 * 1024,
    env: options.env ?? process.env,
  });
}

async function waitForExit(child, timeoutMs = 10_000) {
  if (child.exitCode !== null) return { code: child.exitCode, signal: child.signalCode };
  return Promise.race([
    once(child, "exit").then(([code, signal]) => ({ code, signal })),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("child exit timed out")), timeoutMs)
    ),
  ]);
}

async function probeNamedPipe(runRoot) {
  const pipeName = "tsukiori-" + randomUUID().replaceAll("-", "");
  const ready = join(runRoot, "pipe.ready");
  const reportPath = join(runRoot, "pipe-report.json");
  const server = spawn(
    "pwsh",
    [
      "-NoLogo",
      "-NoProfile",
      "-File",
      pipeScript,
      "-Mode",
      "server",
      "-PipeName",
      pipeName,
      "-ReadyFile",
      ready,
      "-ReportFile",
      reportPath,
    ],
    { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stderr = "";
  server.stderr.setEncoding("utf8");
  server.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-8192); });

  try {
    await waitFor(async () => {
      try { await access(ready); return true; }
      catch { return false; }
    }, { timeoutMs: 15_000 });

    const first = JSON.parse((await run("pwsh", [
      "-NoLogo", "-NoProfile", "-File", pipeScript,
      "-Mode", "client", "-PipeName", pipeName, "-Message", "first",
    ])).stdout.trim());
    const daemonPersistedBetweenClients = server.exitCode === null;
    const second = JSON.parse((await run("pwsh", [
      "-NoLogo", "-NoProfile", "-File", pipeScript,
      "-Mode", "client", "-PipeName", pipeName, "-Message", "second",
    ])).stdout.trim());
    const exit = await waitForExit(server, 15_000);
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    const onlyCurrentUserRule = (
      report.accessRuleCount === 1 &&
      report.accessRules.length === 1 &&
      report.accessRules[0].sid === report.currentSid &&
      report.accessRules[0].type === "Allow" &&
      report.ownerSid === report.currentSid
    );
    return {
      currentUserOnly: report.currentUserOnly === true && onlyCurrentUserRule,
      accessRuleCount: report.accessRuleCount,
      reconnects: (
        first.connected === true &&
        first.response === "ack:first" &&
        second.connected === true &&
        second.response === "ack:second" &&
        report.acceptedConnections === 2
      ),
      daemonPersistedBetweenClients,
      serverExitCode: exit.code,
    };
  } catch (error) {
    throw new Error("named pipe probe failed: " + error.message + (stderr ? " stderr=" + stderr : ""));
  } finally {
    if (server.exitCode === null) {
      server.kill();
      await waitForExit(server).catch(() => {});
    }
  }
}

async function probeJobObject() {
  const { stdout } = await run(
    "pwsh",
    ["-NoLogo", "-NoProfile", "-File", jobScript, "-Mode", "main"],
    { timeout: 60_000 },
  );
  return JSON.parse(stdout.trim());
}

function runInteractivePty(marker) {
  return new Promise((resolveProbe, reject) => {
    const terminal = pty.spawn("powershell.exe", ["-NoLogo", "-NoProfile"], {
      name: "xterm-color",
      cols: 80,
      rows: 24,
      cwd: root,
      env: process.env,
      useConpty: true,
    });
    let output = "";
    let exitSent = false;
    const timeout = setTimeout(() => {
      terminal.kill();
      reject(new Error("ConPTY interactive probe timed out"));
    }, 20_000);
    terminal.resize(100, 30);
    terminal.onData((data) => {
      output += data;
      if (!exitSent && output.includes(marker)) {
        exitSent = true;
        terminal.write("exit\r");
      }
    });
    terminal.onExit(({ exitCode, signal }) => {
      clearTimeout(timeout);
      resolveProbe({
        exitCode,
        signal,
        markerObserved: output.includes(marker),
        outputBytes: Buffer.byteLength(output),
        resized: true,
      });
    });
    setTimeout(() => terminal.write("Write-Output " + marker + "\r"), 250);
  });
}

async function probePtyPackaging(runRoot) {
  const direct = await runInteractivePty("TSUKIORI_PTY_DIRECT_OK");
  const nodePtyRoot = await realpath(join(root, "node_modules", "node-pty"));
  const addonRoot = await realpath(join(dirname(nodePtyRoot), "node-addon-api"));
  const sourcePackage = dirname(nodePtyRoot);
  const nativePath = join(nodePtyRoot, "prebuilds", "win32-x64", "pty.node");
  const nativeStat = await stat(nativePath);
  const nativeSha256 = createHash("sha256").update(await readFile(nativePath)).digest("hex");
  const packageJson = JSON.parse(await readFile(join(nodePtyRoot, "package.json"), "utf8"));

  const staged = join(runRoot, "packaged-pty");
  const stagedModules = join(staged, "node_modules");
  await mkdir(stagedModules, { recursive: true });
  await cp(nodePtyRoot, join(stagedModules, "node-pty"), {
    recursive: true,
    filter(source) {
      const rel = relative(nodePtyRoot, source);
      if (!rel) return true;
      if (rel.split(sep).includes("node_modules")) return false;
      if (rel.endsWith(".pdb")) return false;
      if (rel.startsWith("prebuilds" + sep) && !rel.startsWith(join("prebuilds", "win32-x64"))) {
        return false;
      }
      return true;
    },
  });
  await cp(addonRoot, join(stagedModules, "node-addon-api"), {
    recursive: true,
    filter(source) { return !source.endsWith(".pdb"); },
  });
  await writeFile(join(staged, "package.json"), '{"private":true,"type":"module"}\n', "utf8");
  const packagedScript = `import pty from "node-pty";
const marker = "TSUKIORI_PTY_PACKAGED_OK";
const terminal = pty.spawn("powershell.exe", ["-NoLogo", "-NoProfile"], {
  name: "xterm-color", cols: 80, rows: 24, cwd: process.cwd(), env: process.env, useConpty: true
});
let output = "";
let sent = false;
terminal.onData((data) => {
  output += data;
  if (!sent && output.includes(marker)) { sent = true; terminal.write("exit\\r"); }
});
terminal.onExit(({ exitCode }) => {
  console.log(JSON.stringify({ exitCode, markerObserved: output.includes(marker) }));
  process.exit(exitCode === 0 && output.includes(marker) ? 0 : 1);
});
setTimeout(() => terminal.write("Write-Output " + marker + "\\r"), 250);
setTimeout(() => { terminal.kill(); process.exit(2); }, 20000);
`;
  await writeFile(join(staged, "probe.mjs"), packagedScript, "utf8");
  const packaged = JSON.parse((await run(process.execPath, ["probe.mjs"], {
    cwd: staged,
    timeout: 30_000,
  })).stdout.trim());

  return {
    package: "node-pty",
    version: packageJson.version,
    platform: process.platform,
    architecture: process.arch,
    prebuiltRelativePath: join("prebuilds", "win32-x64", basename(nativePath)).replaceAll("\\", "/"),
    prebuiltBytes: nativeStat.size,
    prebuiltSha256: nativeSha256,
    directInteractive: direct.exitCode === 0 && direct.markerObserved && direct.resized,
    packagedInteractive: packaged.exitCode === 0 && packaged.markerObserved,
    sourcePackageLocated: basename(sourcePackage) === "node_modules",
  };
}

async function probeGitWorktree() {
  const base = resolve("C:\\tmp", "tw-" + randomUUID().slice(0, 8));
  const allowed = resolve("C:\\tmp") + sep;
  if (!base.startsWith(allowed)) throw new Error("unexpected short-path base: " + base);
  const repo = join(base, "r");
  const worktree = join(base, "w");
  try {
    await mkdir(repo, { recursive: true });
    await run("git", ["init", "-q", "--initial-branch=main"], { cwd: repo });
    await run("git", ["config", "user.name", "Tsukiori Spike"], { cwd: repo });
    await run("git", ["config", "user.email", "spike@localhost"], { cwd: repo });
    await writeFile(join(repo, "README.md"), "short worktree fixture\n", "utf8");
    await run("git", ["add", "README.md"], { cwd: repo });
    await run("git", ["commit", "-q", "-m", "fixture"], { cwd: repo });
    await run("git", ["worktree", "add", "-q", "-b", "probe", worktree], { cwd: repo });
    const clean = (await run("git", ["status", "--porcelain"], { cwd: worktree })).stdout.trim();
    await writeFile(join(worktree, "marker.txt"), "status probe\n", "utf8");
    const changed = (await run("git", ["status", "--porcelain"], { cwd: worktree })).stdout.trim();
    await run("git", ["worktree", "remove", "--force", worktree], { cwd: repo });
    let removed = false;
    try { await access(worktree); }
    catch { removed = true; }
    return {
      basePathLength: base.length,
      cleanStatusObserved: clean === "",
      changeStatusObserved: changed === "?? marker.txt",
      removed,
      nativeGit: (await run("git", ["--version"])).stdout.trim(),
    };
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

function startRole() {
  return spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    windowsHide: true,
    stdio: "ignore",
  });
}

function isAlive(child) {
  return child.exitCode === null && child.signalCode === null;
}

async function stopRole(child) {
  if (!child || !isAlive(child)) return;
  child.kill();
  await waitForExit(child).catch(() => {});
}

async function runCrashScenario(target) {
  const roles = {
    gui: startRole(),
    daemon: startRole(),
    runtime: startRole(),
  };
  try {
    await waitFor(() => Object.values(roles).every(isAlive), { timeoutMs: 5_000 });
    await stopRole(roles[target]);
    const state = reconcileCrash({
      guiAlive: isAlive(roles.gui),
      daemonAlive: isAlive(roles.daemon),
      runtimeAlive: isAlive(roles.runtime),
    });
    return {
      target,
      state,
      survivors: Object.fromEntries(
        Object.entries(roles).map(([role, child]) => [role, isAlive(child)])
      ),
    };
  } finally {
    await Promise.all(Object.values(roles).map(stopRole));
  }
}

async function probeCrashStates() {
  const scenarios = await Promise.all([
    runCrashScenario("gui"),
    runCrashScenario("daemon"),
    runCrashScenario("runtime"),
  ]);
  return {
    scenarios,
    expected: (
      scenarios.find((s) => s.target === "gui")?.state === "gui_down_control_and_runtime_alive" &&
      scenarios.find((s) => s.target === "daemon")?.state === "daemon_down_runtime_orphaned" &&
      scenarios.find((s) => s.target === "runtime")?.state === "runtime_exited_daemon_alive"
    ),
  };
}

async function main() {
  if (process.platform !== "win32" || process.arch !== "x64") {
    throw new Error("T0.3 requires Windows x64");
  }
  await mkdir(privateRoot, { recursive: true });
  await mkdir(fixtureRoot, { recursive: true });
  const runRoot = await mkdtemp(join(tmpdir(), "tsukiori-t03-"));
  try {
    const [pipe, job, ptyResult, git, crash] = await Promise.all([
      probeNamedPipe(runRoot),
      probeJobObject(),
      probePtyPackaging(runRoot),
      probeGitWorktree(),
      probeCrashStates(),
    ]);
    const result = {
      generatedAt: new Date().toISOString(),
      platform: process.platform,
      architecture: process.arch,
      nodeVersion: process.version,
      pipe,
      job,
      pty: ptyResult,
      git,
      crash,
    };
    const required = [
      pipe.currentUserOnly,
      pipe.reconnects,
      pipe.daemonPersistedBetweenClients,
      pipe.serverExitCode === 0,
      job.jobAssigned,
      job.treeTerminatedOnJobClose,
      job.guardRejectedStaleIdentity,
      job.unrelatedSurvivedGuard,
      ptyResult.directInteractive,
      ptyResult.packagedInteractive,
      ptyResult.platform === "win32",
      ptyResult.architecture === "x64",
      git.cleanStatusObserved,
      git.changeStatusObserved,
      git.removed,
      crash.expected,
    ];
    result.allRequiredChecksPassed = required.every(Boolean);
    const stableResult = structuredClone(result);
    stableResult.generatedAt = "<timestamp>";
    const serialized = JSON.stringify(stableResult, null, 2) + "\n";
    await writeFile(join(privateRoot, "result.json"), serialized, "utf8");
    await writeFile(join(fixtureRoot, "control-plane-result.json"), serialized, "utf8");
    await writeFile(
      join(fixtureRoot, "control-plane-result.sha256"),
      createHash("sha256").update(serialized).digest("hex") + "\n",
      "utf8",
    );
    process.stdout.write(JSON.stringify(stableResult, null, 2) + "\n");
    if (!result.allRequiredChecksPassed) {
      throw new Error("T0.3 required checks did not all pass");
    }
  } finally {
    await rm(runRoot, { recursive: true, force: true });
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    process.stderr.write((error?.stack ?? String(error)) + "\n");
    process.exit(1);
  },
);
