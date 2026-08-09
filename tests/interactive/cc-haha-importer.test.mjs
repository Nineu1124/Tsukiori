import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const { CcHahaImporter } = await import(
  new URL('../../apps/desktop/dist/electron-main/cc-haha-importer.js', import.meta.url)
);

function git(cwd, args) {
  return execFileSync('git.exe', ['-C', cwd, ...args], {
    encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function importFixture(t) {
  const temporary = mkdtempSync(join(tmpdir(), 'tsukiori-cc-haha-import-'));
  const repository = join(temporary, 'repository');
  const sourceRoot = join(temporary, 'cc-haha-config');
  const projectDirectory = join(sourceRoot, 'projects', 'lossy-directory-name');
  const userData = join(temporary, 'user-data');
  const sourceSessionId = '00000000-0000-4000-8000-000000000077';
  const sourceFile = join(projectDirectory, `${sourceSessionId}.jsonl`);
  mkdirSync(projectDirectory, { recursive: true });
  execFileSync('git.exe', ['init', '--quiet', repository]);
  git(repository, ['config', 'user.name', 'Tsukiori Test']);
  git(repository, ['config', 'user.email', 'test@tsukiori.invalid']);
  writeFileSync(join(repository, 'README.md'), '# import fixture\n');
  git(repository, ['add', 'README.md']);
  git(repository, ['commit', '-m', 'init']);
  const rows = [
    { type: 'custom-title', customTitle: 'Imported planning session', cwd: repository, timestamp: '2026-01-02T03:04:05.000Z' },
    { type: 'user', uuid: 'user-row', cwd: repository, timestamp: '2026-01-02T03:04:06.000Z', message: { id: 'user-1', content: 'hello from cc-haha' } },
    { type: 'assistant', uuid: 'assistant-row', cwd: repository, timestamp: '2026-01-02T03:04:07.000Z', message: { id: 'assistant-1', model: 'claude-sonnet-4-5', content: [
      { type: 'thinking', thinking: 'safe imported reasoning summary' },
      { type: 'text', text: 'imported assistant answer' },
      { type: 'tool_use', id: 'tool-1', name: 'Read', input: { path: 'MUST_NOT_IMPORT_RAW_TOOL_INPUT' } },
    ] } },
    { type: 'user', uuid: 'tool-result-row', cwd: repository, timestamp: '2026-01-02T03:04:08.000Z', message: { id: 'user-2', content: [
      { type: 'tool_result', tool_use_id: 'tool-1', content: 'MUST_NOT_IMPORT_RAW_TOOL_RESULT' },
    ] } },
  ];
  writeFileSync(sourceFile, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
  t.after(() => rmSync(temporary, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }));
  return { sourceRoot, sourceFile, sourceSessionId, repository, userData };
}

test('cc-haha importer performs read-only discovery, safe conversion, and hash idempotence', (t) => {
  const f = importFixture(t);
  const sourceBefore = readFileSync(f.sourceFile, 'utf8');
  const importer = new CcHahaImporter(f.userData);
  const scan = importer.scan(f.sourceRoot);
  assert.equal(scan.importableCount, 1);
  assert.equal(scan.sessions[0].projectRoot.toLowerCase(), f.repository.toLowerCase());
  assert.match(scan.sessions[0].transcriptHash, /^sha256:[a-f0-9]{64}$/);
  const converted = importer.convert(scan.sessions[0]);
  const serialized = JSON.stringify(converted);
  assert.match(serialized, /hello from cc-haha/);
  assert.match(serialized, /imported assistant answer/);
  assert.match(serialized, /Imported Read invocation/);
  assert.doesNotMatch(serialized, /MUST_NOT_IMPORT_RAW_TOOL_(?:INPUT|RESULT)/);
  assert.equal(converted.turnCount, 1);
  importer.recordImport(scan.sourceFingerprint, [{
    transcriptHash: scan.sessions[0].transcriptHash,
    sourceSessionId: f.sourceSessionId,
    targetSessionId: 'session:target',
    projectId: 'project:target',
  }]);
  const repeated = importer.scan(f.sourceRoot);
  assert.equal(repeated.importableCount, 0);
  assert.equal(repeated.alreadyImportedCount, 1);
  assert.equal(readFileSync(f.sourceFile, 'utf8'), sourceBefore);
});

test('cc-haha importer refuses a transcript changed after Dry Run', (t) => {
  const f = importFixture(t);
  const importer = new CcHahaImporter(f.userData);
  const scan = importer.scan(f.sourceRoot);
  writeFileSync(f.sourceFile, readFileSync(f.sourceFile, 'utf8') + JSON.stringify({ type: 'system', cwd: f.repository }) + '\n');
  assert.throws(() => importer.convert(scan.sessions[0]), /Dry Run 后发生变化/);
});

test('cc-haha importer fails closed when its idempotence manifest is corrupted', (t) => {
  const f = importFixture(t);
  const importer = new CcHahaImporter(f.userData);
  const manifest = join(f.userData, 'imports', 'cc-haha', 'manifest-v1.json');
  writeFileSync(manifest, '{not-json');
  assert.throws(() => importer.scan(f.sourceRoot), /Manifest 已损坏.*重复导入/);
});
