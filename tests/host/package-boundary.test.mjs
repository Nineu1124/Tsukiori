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
  const [protocol, domain, database, runtimeCore, fakeAdapter, codexAdapter, permissionBroker, projectManager, worktreeManager, workspaceManager, gitService, testkit, daemon, desktop] = await Promise.all([
    manifest('packages/protocol'),
    manifest('packages/domain'),
    manifest('packages/database'),
    manifest('packages/runtime-core'),
    manifest('packages/adapter-fake'),
    manifest('packages/adapter-codex'),
    manifest('packages/permission-broker'),
    manifest('packages/project-manager'),
    manifest('packages/worktree-manager'),
    manifest('packages/workspace-manager'),
    manifest('packages/git-service'),
    manifest('packages/testkit'),
    manifest('apps/daemon'),
    manifest('apps/desktop'),
  ]);

  assert.deepEqual(protocol.dependencies ?? {}, {});
  assert.deepEqual(domain.dependencies ?? {}, {});
  assert.equal(database.dependencies['@tsukiori/domain'], 'workspace:*');
  assert.equal(database.dependencies['better-sqlite3'], '12.8.0');
  assert.equal(database.dependencies['drizzle-orm'], '0.45.2');
  assert.deepEqual(runtimeCore.dependencies, { '@tsukiori/domain': 'workspace:*' });
  assert.deepEqual(fakeAdapter.dependencies, { '@tsukiori/runtime-core': 'workspace:*' });
  assert.deepEqual(codexAdapter.dependencies, {
    '@tsukiori/database': 'workspace:*',
    '@tsukiori/domain': 'workspace:*',
    '@tsukiori/permission-broker': 'workspace:*',
    '@tsukiori/project-manager': 'workspace:*',
    '@tsukiori/runtime-core': 'workspace:*',
  });
  assert.deepEqual(permissionBroker.dependencies, {
    '@tsukiori/database': 'workspace:*',
    '@tsukiori/domain': 'workspace:*',
  });
  assert.deepEqual(projectManager.dependencies, {
    '@tsukiori/database': 'workspace:*',
    '@tsukiori/domain': 'workspace:*',
  });
  assert.deepEqual(worktreeManager.dependencies, {
    '@tsukiori/database': 'workspace:*',
    '@tsukiori/domain': 'workspace:*',
    '@tsukiori/project-manager': 'workspace:*',
  });
  assert.deepEqual(workspaceManager.dependencies, {
    '@tsukiori/database': 'workspace:*',
    '@tsukiori/domain': 'workspace:*',
    '@tsukiori/project-manager': 'workspace:*',
    '@tsukiori/worktree-manager': 'workspace:*',
  });
  assert.deepEqual(gitService.dependencies, {
    '@tsukiori/database': 'workspace:*',
    '@tsukiori/domain': 'workspace:*',
    '@tsukiori/project-manager': 'workspace:*',
  });
  assert.deepEqual(testkit.dependencies, {
    '@tsukiori/protocol': 'workspace:*',
  });
  assert.deepEqual(daemon.dependencies, {
    '@tsukiori/protocol': 'workspace:*',
  });
  assert.deepEqual(desktop.dependencies, {
    '@tsukiori/adapter-fake': 'workspace:*',
    '@tsukiori/protocol': 'workspace:*',
  });

  const manifests = [protocol, domain, database, runtimeCore, fakeAdapter, codexAdapter, permissionBroker, projectManager, worktreeManager, workspaceManager, gitService, testkit, daemon, desktop];
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
