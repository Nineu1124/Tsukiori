import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const assetRoot = join(root, 'apps', 'desktop', 'renderer', 'assets', 'generated', 'v1.1');
const designRoot = join(root, 'docs', 'design', 'v1.1');

async function pngSize(file) {
  const content = await readFile(file);
  assert.equal(content.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', `${file} is not a PNG`);
  return {
    width: content.readUInt32BE(16),
    height: content.readUInt32BE(20),
    bytes: content.length,
  };
}

test('V1.1 generated artwork is project-local, high resolution, and bundled by renderer CSS', async () => {
  const assets = [
    'onboarding-hero.png',
    'project-worktrees.png',
    'capability-hub.png',
    'work-panel-watermark.png',
    'multi-agent-empty-state.png',
  ];
  const styles = await readFile(join(root, 'apps', 'desktop', 'renderer', 'styles.css'), 'utf8');
  for (const asset of assets) {
    const size = await pngSize(join(assetRoot, asset));
    assert.ok(size.width >= 1000, `${asset} width is too small`);
    assert.ok(size.height >= 800, `${asset} height is too small`);
    assert.ok(size.bytes >= 100_000, `${asset} appears to be a placeholder`);
    assert.match(styles, new RegExp(`assets/generated/v1\\.1/${asset.replace('.', '\\.')}`));
  }
  assert.match(styles, /\.attention-panel\s*\{\s*overflow-x:\s*hidden/);
  assert.match(styles, /body\.reduce-motion \.empty-workspace/);
});

test('complete design delivery contains the ImageGen board and all 32 rendered application screens', async () => {
  const board = await pngSize(join(designRoot, 'tsukiori-complete-ui-board.png'));
  assert.ok(board.width >= 1500);
  assert.ok(board.height >= 900);

  const mainScreens = (await readdir(join(designRoot, 'screens'))).filter((name) => name.endsWith('.png'));
  const settingsScreens = (await readdir(join(designRoot, 'screens', 'settings'))).filter((name) => name.endsWith('.png'));
  assert.equal(mainScreens.length, 13);
  assert.equal(settingsScreens.length, 19);

  for (const name of mainScreens) {
    const size = await pngSize(join(designRoot, 'screens', name));
    assert.equal(size.width, 1600);
    assert.equal(size.height, 1000);
  }
  for (const name of settingsScreens) {
    const size = await pngSize(join(designRoot, 'screens', 'settings', name));
    assert.equal(size.width, 1600);
    assert.equal(size.height, 1000);
  }
});

test('design capture remains isolated from real projects and credentials', async () => {
  const script = await readFile(join(root, 'scripts', 'capture-complete-design.mjs'), 'utf8');
  assert.match(script, /mkdtempSync\(join\(tmpdir\(\), 'tsukiori-design-v11-'\)\)/);
  assert.match(script, /--user-data-dir=/);
  assert.match(script, /TSUKIORI_DAEMON_EXIT_POLICY:\s*'stop'/);
  assert.match(script, /rmSync\(userData, \{ recursive: true, force: true \}\)/);
  assert.doesNotMatch(script, /sk-[a-zA-Z0-9_-]{12,}/);
  assert.doesNotMatch(script, /API Key['"]?\s*[:=]\s*['"][^'"]+/i);
});
