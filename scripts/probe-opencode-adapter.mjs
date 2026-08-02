import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '..');
const { LocalDatabase } = await import(pathToFileURL(join(root, 'packages/database/dist/index.js')).href);
const { ExecutionEnvironmentRegistry } = await import(
  pathToFileURL(join(root, 'packages/project-manager/dist/index.js')).href
);
const { OpenCodeRuntimeAdapter } = await import(
  pathToFileURL(join(root, 'packages/adapter-opencode/dist/index.js')).href
);
const directory = mkdtempSync(join(tmpdir(), 'tsukiori-real-opencode-probe-'));
const repository = join(directory, 'repository');
const worktree = join(directory, 'worktree');
const database = new LocalDatabase({ filePath: join(directory, 'state.db'), blobRoot: join(directory, 'blobs') });
let handle;

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

try {
  mkdirSync(repository);
  git(['init', '-b', 'main'], repository);
  git(['config', 'user.name', 'Tsukiori Probe'], repository);
  git(['config', 'user.email', 'probe@invalid.local'], repository);
  writeFileSync(join(repository, 'README.md'), '# isolated probe\n');
  git(['add', 'README.md'], repository);
  git(['commit', '-m', 'probe fixture'], repository);
  git(['worktree', 'add', '-b', 'provider-probe', worktree], repository);

  const environments = new ExecutionEnvironmentRegistry(database);
  const environment = environments.registerWindowsNative({ homePath: directory });
  const adapter = new OpenCodeRuntimeAdapter(database, environments, {
    executionEnvironmentId: environment.id,
    openApiManifestPath: join(root, 'tests', 'fixtures', 'opencode', '1.18.4', 'openapi-manifest.json'),
  });
  const profile = adapter.probe();
  handle = await adapter.start(profile.id, worktree);
  const selection = handle.selectProvider('dpsk', 'deepseek-v4-flash');
  const eventReaderCount = handle.eventReaderCount;
  const globalEventStreamConnected = handle.eventStreamState === 'connected';
  const verification = await handle.verifyProviderConnection(selection.providerId, selection.modelId);
  const handleId = handle.id;
  const workspacePathVerified = handle.providers.workspacePathVerified;
  await handle.stop();
  handle = undefined;

  const persisted = JSON.stringify({
    profiles: database.listRuntimeProfiles('opencode'),
    handles: database.listRuntimeHandles(profile.id),
    audits: database.listRuntimeAudits('opencode'),
  });
  const forbiddenPersisted = /TSUKIORI_PROVIDER_OK|OPENCODE_SERVER_PASSWORD|Authorization|Basic\s+[A-Za-z0-9+/=]+|sk-[A-Za-z0-9]/.test(persisted);
  if (forbiddenPersisted) throw new Error('Provider probe detected forbidden persisted content');

  process.stdout.write(JSON.stringify({
    task: 'T3.1',
    runtime: 'opencode',
    pathFingerprint: 'sha256:' + createHash('sha256').update(profile.executablePath).digest('hex'),
    version: profile.discoveredVersion,
    compatibility: profile.compatibility,
    authenticated: profile.authenticated,
    providerId: selection.providerId,
    modelId: selection.modelId,
    destinationHost: selection.destinationHost,
    workspacePathVerified,
    eventReaderCount,
    globalEventStreamConnected,
    completed: verification.completed,
    finalHandleState: database.readRuntimeHandle(handleId)?.state,
    persistedPromptOrOutput: false,
    containsCredentials: false,
  }, null, 2) + '\n');
} finally {
  if (handle) await handle.stop().catch(() => undefined);
  database.close();
  rmSync(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
}