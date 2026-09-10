/**
 * Unit tests for policy YAML parsing, validation errors, and per-project
 * policy resolution (defaults ← project override).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePolicyConfig, PolicyConfigError } from '../../config/policy-config.ts';
import { resolvePolicy } from './index.ts';

const VALID_YAML = `
defaults:
  review_on: [open, ready, manual]
  strictness: balanced
  model: "cursor-grok-4.6-high-fast"
  ignored_globs:
    - "**/*.lock"
    - "**/dist/**"
  context_budget:
    max_chunk_tokens: 60000
    estimate: bytes
  decomposition:
    mode: single

discovery:
  mode: explicit
  projects:
    - devops/ai-agents/pilot-a
    - devops/ai-agents/pilot-b

projects:
  devops/ai-agents/pilot-a:
    strictness: strict
    review_on: [open, ready, push, manual]
`;

void test('parsePolicyConfig accepts a valid YAML document', () => {
  const config = parsePolicyConfig(VALID_YAML);

  assert.equal(config.defaults.strictness, 'balanced');
  assert.equal(config.defaults.model, 'cursor-grok-4.6-high-fast');
  assert.equal(config.defaults.reviewOn.open, true);
  assert.equal(config.defaults.reviewOn.ready, true);
  assert.equal(config.defaults.reviewOn.push, false);
  assert.equal(config.defaults.reviewOn.manual, true);
  assert.equal(config.defaults.contextBudget.maxChunkTokens, 60_000);
  assert.equal(config.defaults.contextBudget.estimate, 'bytes');
  assert.equal(config.defaults.decomposition.mode, 'single');
  assert.deepEqual(config.discovery, {
    mode: 'explicit',
    projects: ['devops/ai-agents/pilot-a', 'devops/ai-agents/pilot-b'],
  });
});

void test('parsePolicyConfig throws on invalid strictness with a clear message', () => {
  const yaml = `
defaults:
  strictness: ultra
discovery:
  mode: explicit
  projects: []
`;

  assert.throws(
    () => parsePolicyConfig(yaml),
    (err: unknown) => {
      assert.ok(err instanceof PolicyConfigError);
      assert.match(err.message, /config\.defaults\.strictness/);
      assert.match(err.message, /ultra/);
      return true;
    },
  );
});

void test('resolvePolicy merges defaults with per-project overrides', () => {
  const config = parsePolicyConfig(VALID_YAML);

  const pilotA = resolvePolicy(config, 'devops/ai-agents/pilot-a');
  assert.equal(pilotA.strictness, 'strict');
  assert.equal(pilotA.reviewOn.push, true);
  assert.equal(pilotA.model, 'cursor-grok-4.6-high-fast');
  assert.equal(pilotA.contextBudget.maxChunkTokens, 60_000);

  const pilotB = resolvePolicy(config, 'devops/ai-agents/pilot-b');
  assert.equal(pilotB.strictness, 'balanced');
  assert.equal(pilotB.reviewOn.push, false);

  const unknown = resolvePolicy(config, 'other/unknown');
  assert.deepEqual(unknown, config.defaults);
});

void test('parsePolicyConfig parses profile and resolvePolicy inherits/overrides it', () => {
  const yaml = `
defaults:
  strictness: balanced
  profile: node
discovery:
  mode: explicit
  projects:
    - g/py-svc
    - g/keep-default
projects:
  g/py-svc:
    profile: python
`;
  const config = parsePolicyConfig(yaml);

  assert.equal(config.defaults.profile, 'node');
  // Explicit per-project profile overrides the default.
  assert.equal(resolvePolicy(config, 'g/py-svc').profile, 'python');
  // Project without an override inherits the default profile.
  assert.equal(resolvePolicy(config, 'g/keep-default').profile, 'node');
  // Unknown project falls back to defaults (incl. its profile).
  assert.equal(resolvePolicy(config, 'g/unknown').profile, 'node');
});

void test('parsePolicyConfig rejects a non-string profile', () => {
  const yaml = `
defaults:
  profile: 123
discovery:
  mode: explicit
  projects: []
`;
  assert.throws(
    () => parsePolicyConfig(yaml),
    (err: unknown) => {
      assert.ok(err instanceof PolicyConfigError);
      assert.match(err.message, /config\.defaults\.profile/);
      return true;
    },
  );
});
