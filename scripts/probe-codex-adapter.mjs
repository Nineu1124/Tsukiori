import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '..');
const privateEntry = join(
  root, 'artifacts', 'private', 't0.2', 'runtime', 'node_modules', '@openai', 'codex', 'bin', 'codex.js',
);
const globalEntry = process.env.APPDATA
  ? join(process.env.APPDATA, 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js')
  : '';
const entry = existsSync(privateEntry) ? privateEntry : globalEntry;
if (!entry || !existsSync(entry)) throw new Error('No JavaScript Codex CLI entry was discovered');

const { LocalDatabase } = await import(pathToFileURL(join(root, 'packages/database/dist/index.js')).href);
const { ExecutionEnvironmentRegistry } = await import(pathToFileURL(join(root, 'packages/project-manager/dist/index.js')).href);
const { CodexRuntimeAdapter } = await import(pathToFileURL(join(root, 'packages/adapter-codex/dist/index.js')).href);
const directory = mkdtempSync(join(tmpdir(), 'tsukiori-real-codex-probe-'));
const database = new LocalDatabase({ filePath: join(directory, 'state.db'), blobRoot: join(directory, 'blobs') });

try {
  const environments = new ExecutionEnvironmentRegistry(database);
  const environment = environments.registerWindowsNative({ homePath: directory });
  const schemaRoot = join(root, 'tests', 'fixtures', 'codex', '0.146.0');
  const adapter = new CodexRuntimeAdapter(database, environments, {
    executionEnvironmentId: environment.id,
    schemaManifestPath: join(schemaRoot, 'schema-manifest.json'),
    schemaBundlePath: join(schemaRoot, 'codex_app_server_protocol.schemas.json'),
    candidates: () => [{ executable: process.execPath, prefixArgs: [entry], source: 'explicit' }],
  });
  const profile = adapter.probe();
  const handle = await adapter.start(profile.id, root);
  await handle.stop();
  process.stdout.write(JSON.stringify({
    runtime: 'codex', version: profile.discoveredVersion, compatibility: profile.compatibility,
    authenticated: handle.auth.authenticated, authSource: handle.auth.source,
    requiresOpenaiAuth: handle.auth.requiresOpenaiAuth,
    finalHandleState: database.readRuntimeHandle(handle.id)?.state,
    auditActions: [...new Set(database.listRuntimeAudits('codex').map((audit) => audit.action))],
    containsCredentials: false,
  }, null, 2) + '\n');
} finally {
  database.close();
  rmSync(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
}
