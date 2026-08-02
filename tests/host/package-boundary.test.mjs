import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

async function manifest(path) {
  return JSON.parse(await readFile(join(repositoryRoot, path, 'package.json'), 'utf8'));
}

test('workspace package dependency direction follows the architecture boundary', async () => {
  const [protocol, testkit, daemon, desktop] = await Promise.all([
    manifest('packages/protocol'),
    manifest('packages/testkit'),
    manifest('apps/daemon'),
    manifest('apps/desktop'),
  ]);

  assert.deepEqual(protocol.dependencies ?? {}, {});
  assert.deepEqual(testkit.dependencies, {
    '@tsukiori/protocol': 'workspace:*',
  });
  assert.deepEqual(daemon.dependencies, {
    '@tsukiori/protocol': 'workspace:*',
  });
  assert.deepEqual(desktop.dependencies, {
    '@tsukiori/protocol': 'workspace:*',
  });

  const manifests = [protocol, testkit, daemon, desktop];
  for (const packageJson of manifests) {
    const dependencies = {
      ...packageJson.dependencies,
      ...packageJson.devDependencies,
    };
    assert.equal(
      Object.keys(dependencies).some((name) => name.includes('/desktop') || name.includes('/daemon')),
      false,
      packageJson.name + ' must not import an application package',
    );
  }
});

test('workspace and build graph declare only explicit app and package roots', async () => {
  const workspace = await readFile(join(repositoryRoot, 'pnpm-workspace.yaml'), 'utf8');
  assert.match(workspace, /apps\/\*/);
  assert.match(workspace, /packages\/\*/);
  assert.doesNotMatch(workspace, /src\/services|src\/utils|src\/helpers/);

  const turbo = JSON.parse(await readFile(join(repositoryRoot, 'turbo.json'), 'utf8'));
  assert.deepEqual(turbo.tasks.build.dependsOn, ['^build']);
  assert.deepEqual(turbo.tasks.typecheck.dependsOn, ['^build']);
});
