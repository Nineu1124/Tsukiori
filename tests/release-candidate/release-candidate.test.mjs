import assert from 'node:assert/strict';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const databaseModule = await import(
  pathToFileURL(join(root, 'packages', 'database', 'dist', 'index.js')).href,
);
const protocol = await import(
  pathToFileURL(join(root, 'packages', 'protocol', 'dist', 'index.js')).href,
);
const { LocalDatabase } = databaseModule;
const compatibility = fixture('tests/fixtures/release/v1.0.0-rc.1-compatibility.json');
const acceptanceEvidence = fixture('tests/fixtures/release/v1-acceptance-evidence.json');

function fixture(path) {
  return JSON.parse(readFileSync(join(root, path), 'utf8'));
}

test('V1 RC locks Desktop, Daemon, Runtime versions, Schema hashes, and knownIssues', () => {
  const desktopPackage = fixture('apps/desktop/package.json');
  const daemonPackage = fixture('apps/daemon/package.json');
  const opencodeManifest = fixture('tests/fixtures/opencode/1.18.4/openapi-manifest.json');
  const opencodeCapabilities = fixture('tests/fixtures/opencode/1.18.4/capability-matrix.json');
  const codexManifest = fixture('tests/fixtures/codex/0.146.0/schema-manifest.json');
  const codexCapabilities = fixture('tests/fixtures/codex/0.146.0/capability-matrix.json');
  assert.equal(compatibility.releaseCandidate, '1.0.0-rc.1');
  assert.equal(desktopPackage.version, compatibility.desktop.version);
  assert.equal(daemonPackage.version, compatibility.daemon.version);
  assert.equal(protocol.DAEMON_VERSION, compatibility.daemon.version);
  assert.equal(protocol.HOST_PROTOCOL_VERSION, compatibility.desktop.hostProtocolVersion);
  assert.equal(protocol.IPC_PROTOCOL_VERSION, compatibility.desktop.ipcProtocolVersion);
  const opencode = compatibility.runtimes.find((item) => item.runtime === 'opencode');
  const codex = compatibility.runtimes.find((item) => item.runtime === 'codex');
  assert.equal(opencode.minimumSupportedVersion, opencodeManifest.runtimeVersion);
  assert.equal(opencode.maximumTestedVersion, opencodeManifest.runtimeVersion);
  assert.equal(opencode.schemaSha256, opencodeManifest.sha256);
  assert.deepEqual(opencode.knownIssues, opencodeCapabilities.knownIssues);
  assert.equal(codex.minimumSupportedVersion, '0.146.0');
  assert.equal(codex.maximumTestedVersion, '0.146.0');
  assert.equal(codex.schemaSha256, codexManifest.sha256);
  assert.deepEqual(codex.knownIssues, codexCapabilities.knownIssues);
  assert.equal(compatibility.publication.channel, 'local');
  assert.equal(compatibility.publication.localV1RequiresAuthenticode, false);
  assert.equal(compatibility.publication.verifiedPublisherRequiresAuthenticode, true);
  assert.equal(compatibility.publication.unsignedSmartScreenWarningRequired, true);
  assert.equal(compatibility.publication.testArtifactCommitted, false);
  assert.equal(compatibility.publication.privateSigningMaterialCommitted, false);
});

test('upgrade from the previous database preserves Session history and Workspace Binding facts', (t) => {
  const temporary = mkdtempSync(join(tmpdir(), 'tsukiori-v1-upgrade-'));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const filePath = join(temporary, 'state.db');
  const blobRoot = join(temporary, 'blobs');
  const worktreePath = join(temporary, 'worktree');
  mkdirSync(worktreePath, { recursive: true });
  writeFileSync(join(worktreePath, 'recovery-marker.txt'), 'sanitized worktree state', 'utf8');
  const now = 1_800_000_000_000;
  let database = new LocalDatabase({ filePath, blobRoot, targetVersion: 5 });
  database.saveExecutionEnvironment({
    id: 'env-rc', type: 'windows-native', displayName: 'Windows Native',
    homePath: 'C:\\Users\\fixture', pathStyle: 'windows', defaultShell: 'pwsh.exe',
    gitExecutable: 'git.exe', capabilities: {
      pty: true, processGroups: false, jobObjects: true, symlinks: true,
    }, createdAt: now, updatedAt: now,
  });
  database.saveProject({
    id: 'project-rc', name: 'RC Upgrade', executionEnvironmentId: 'env-rc',
    rootPath: temporary, gitRoot: temporary, repositoryId: 'repo-rc',
    defaultBranch: 'main', createdAt: now, updatedAt: now,
  });
  database.saveSession({
    id: 'session-rc', title: 'Previous version history', projectId: 'project-rc',
    primaryWorkspaceBindingId: 'binding-rc', runtimeType: 'fake', runtimeProfileId: 'fake-v1',
    lifecycle: 'active', activity: 'idle', health: 'healthy', writeMode: 'isolated-worktree',
    createdAt: now, updatedAt: now,
  });
  database.saveTurn({
    id: 'turn-rc', sessionId: 'session-rc', runtimeTurnId: 'runtime-turn-rc',
    status: 'completed', userInput: { kind: 'fixture', text: '<redacted-input>' },
    startedAt: now, completedAt: now + 1,
  });
  database.saveWorktree({
    id: 'worktree-rc', projectId: 'project-rc', ownerSessionId: 'session-rc',
    executionEnvironmentId: 'env-rc', path: worktreePath, branchName: 'codex/rc-upgrade',
    baseRef: 'main', baseCommit: '0000000000000000000000000000000000000000',
    status: 'active', createdAt: now,
  });
  database.saveWorkspaceBinding({
    id: 'binding-rc', sessionId: 'session-rc', projectId: 'project-rc',
    worktreeId: 'worktree-rc', executionEnvironmentId: 'env-rc', bindingType: 'primary',
    status: 'active', path: worktreePath,
    baseCommit: '0000000000000000000000000000000000000000',
    lastKnownCommit: '1111111111111111111111111111111111111111', cleanupState: 'not_requested',
    createdAt: now, updatedAt: now,
  });
  database.close();

  database = new LocalDatabase({ filePath, blobRoot, backupRoot: join(temporary, 'backups') });
  assert.deepEqual(database.schemaVersions, [1, 2, 3, 4, 5, 6]);
  assert.ok(database.lastMigrationBackup?.endsWith('.db'));
  assert.equal(database.readSession('session-rc')?.title, 'Previous version history');
  assert.equal(database.count('session_turns'), 1);
  assert.equal(database.readWorktree('worktree-rc')?.path, worktreePath);
  assert.equal(database.readWorkspaceBinding('session-rc')?.lastKnownCommit,
    '1111111111111111111111111111111111111111');
  assert.equal(readFileSync(join(worktreePath, 'recovery-marker.txt'), 'utf8'), 'sanitized worktree state');
  database.close();
});

test('every mapped V1 acceptance item in sections 37.1-37.9 has existing auditable evidence', () => {
  const architecture = readFileSync(join(root, '本地多Agent工作台_完整架构与实施方案.md'), 'utf8');
  const start = architecture.indexOf('## 37.1');
  const end = architecture.indexOf('# 38.', start);
  assert.ok(start > 0 && end > start);
  const items = architecture.slice(start, end).split(/\r?\n/)
    .filter((line) => /^- \[[ xX]\] \[/.test(line));
  assert.ok(items.length >= 50);
  for (const item of items) {
    const mapping = item.match(/^\- \[[ xX]\] \[([^\]]+)\]/)?.[1] ?? '';
    const ids = [...mapping.matchAll(/T\d+\.\d+|G\d+/g)].map((match) => match[0]);
    assert.ok(ids.length > 0, item);
    for (const id of ids) {
      const paths = acceptanceEvidence.evidence[id];
      assert.ok(Array.isArray(paths) && paths.length > 0, `${id}: missing evidence mapping`);
      for (const path of paths) assert.equal(existsSync(join(root, path)), true, `${id}: ${path}`);
    }
  }
});

test('Windows x64 CI runs the required V1 regression and clean installer lifecycle', () => {
  const workflow = readFileSync(join(root, '.github', 'workflows', 'windows-ci.yml'), 'utf8');
  for (const command of [
    'npm run test:contract', 'npm run test:git', 'npm run test:recovery',
    'npm run test:security', 'npm run test:alpha', 'npm run test:dual-runtime',
    'npm run test:release', 'npm run test:release-candidate',
  ]) assert.match(workflow, new RegExp(command.replaceAll(':', '\\:')));
  assert.match(workflow, /verify-windows-release-candidate\.ps1/);
});
