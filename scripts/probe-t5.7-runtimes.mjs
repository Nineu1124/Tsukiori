import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const root = process.cwd();
const { discoverCodexLaunch } = await import(pathToFileURL(
  join(root, 'apps', 'desktop', 'dist', 'electron-main', 'codex-app-server-client.js'),
).href);
const { discoverClaudeLaunch } = await import(pathToFileURL(
  join(root, 'apps', 'desktop', 'dist', 'electron-main', 'claude-code-client.js'),
).href);
const { builtInProviders } = await import(pathToFileURL(
  join(root, 'apps', 'desktop', 'dist', 'electron-main', 'provider-registry.js'),
).href);

const codex = discoverCodexLaunch();
const claude = discoverClaudeLaunch();
const providers = builtInProviders(0).map(({ id, name, kind, apiFormat, baseUrl, models }) => ({
  id, name, kind, apiFormat, baseUrl, models, configured: kind === 'chatgpt',
}));

process.stdout.write(JSON.stringify({
  schemaVersion: 1,
  platform: 'windows-native-x64',
  runtimes: [
    { type: 'codex', version: codex.version, source: codex.source, supportLevel: 'supported', protocol: 'app-server' },
    { type: 'claude', version: claude.version, source: claude.source, supportLevel: 'degraded', protocol: 'stream-json' },
    { type: 'opencode', version: '1.18.4', source: 'adapter-not-connected', supportLevel: 'unknown' },
    { type: 'acp', version: 'unknown', source: 'not-connected', supportLevel: 'unknown' },
  ],
  providers,
  apiKeysRead: false,
  providerRequestsSent: false,
  containsCredentials: false,
  containsPrompts: false,
  containsResponses: false,
}, null, 2) + '\n');
