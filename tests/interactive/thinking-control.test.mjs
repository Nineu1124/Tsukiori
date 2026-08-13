import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const module = await import(pathToFileURL(join(
  root, 'apps', 'desktop', 'dist', 'electron-main', 'thinking-control.js',
)).href);
const { resolveThinkingControl, validatedThinkingEffort } = module;

const verifiedClaude = {
  type: 'claude', available: true, version: '2.1.226', supportLevel: 'degraded',
  capabilities: ['stream-json', 'effort-control'],
};

test('native Claude exposes only the verified CLI Thinking control', () => {
  const matrix = resolveThinkingControl(verifiedClaude, 'claude-native');
  assert.equal(matrix.claudeCli.supportLevel, 'supported');
  assert.equal(matrix.claudeCli.argument, '--effort');
  assert.deepEqual(matrix.modelEffort.values, ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.equal(matrix.modelEffort.supportLevel, 'supported');
  assert.equal(matrix.hostDisplay.affectsModel, false);
  assert.equal(validatedThinkingEffort('max', matrix), 'max');
});

test('DeepSeek API evidence does not imply Claude Code cross-layer effort support', () => {
  const matrix = resolveThinkingControl(verifiedClaude, 'deepseek');
  assert.equal(matrix.providerApi.supportLevel, 'supported');
  assert.equal(matrix.providerApi.parameter, 'output_config.effort');
  assert.equal(matrix.crossLayerMapping.supportLevel, 'unknown');
  assert.equal(matrix.modelEffort.supportLevel, 'unknown');
  assert.throws(() => validatedThinkingEffort('max', matrix), /unknown/);
});

test('unverified and incapable Runtime versions fail closed', () => {
  const unverified = { ...verifiedClaude, version: '2.1.228', available: false, supportLevel: 'unknown' };
  assert.equal(resolveThinkingControl(unverified, 'claude-native').modelEffort.supportLevel, 'unknown');
  const incapable = { ...verifiedClaude, capabilities: ['stream-json'] };
  assert.equal(resolveThinkingControl(incapable, 'claude-native').modelEffort.supportLevel, 'unsupported');
});

test('versioned Probe fixture is sanitized and keeps the rejected mapping unknown', () => {
  const fixture = JSON.parse(readFileSync(join(
    root, 'tests', 'fixtures', 'thinking-control', 'claude-code-2.1.228-deepseek-v4.json',
  ), 'utf8'));
  assert.equal(fixture.claudeCode.version, '2.1.228');
  assert.equal(fixture.claudeCode.probe, 'version-and-help-only');
  assert.equal(fixture.deepSeekProviderApi.anthropicFormat.effortParameter, 'output_config.effort');
  assert.equal(fixture.claudeCodeToDeepSeek.effortMapping, 'unknown');
  assert.equal(fixture.claudeCodeToDeepSeek.rejectedProbe.acceptedAsEvidence, false);
  assert.equal(fixture.containsCredentials, false);
  assert.equal(fixture.containsPrompt, false);
  assert.equal(fixture.containsUserSource, false);
});
