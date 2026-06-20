/**
 * Load and validate the global Mira policy YAML (`/etc/mira/config.yml`).
 * Parses snake_case keys from docs/03-reference/policy-config.md into typed camelCase
 * structures; fails early with precise {@link PolicyConfigError} messages.
 */
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { defaultProjectPolicy } from '../core/policy/defaults.ts';
import type {
  ContextBudget,
  ContextBudgetEstimate,
  DecompositionPolicy,
  ExplicitDiscovery,
  PolicyConfig,
  ProjectPolicy,
  ReviewOnPolicy,
  Strictness,
} from '../core/policy/types.ts';

export class PolicyConfigError extends Error {}

const STRICTNESS_VALUES: readonly Strictness[] = ['strict', 'balanced', 'lenient'];
const ESTIMATE_VALUES: readonly ContextBudgetEstimate[] = ['bytes', 'tokenizer'];
const DECOMPOSITION_MODES: readonly DecompositionPolicy['mode'][] = ['single'];
const REVIEW_ON_TRIGGERS = ['open', 'ready', 'push', 'reopen', 'manual'] as const;
type ReviewOnTrigger = (typeof REVIEW_ON_TRIGGERS)[number];

function fail(path: string, message: string): never {
  throw new PolicyConfigError(`${path}: ${message}`);
}

function expectRecord(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(path, 'expected object');
  }
  return value as Record<string, unknown>;
}

function expectString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    fail(path, 'expected non-empty string');
  }
  return value;
}

function expectBoolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') {
    fail(path, 'expected boolean');
  }
  return value;
}

function expectNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail(path, 'expected finite number');
  }
  return value;
}

function expectStringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) {
    fail(path, 'expected array of strings');
  }
  const result: string[] = [];
  for (let i = 0; i < value.length; i++) {
    const item = value[i];
    if (typeof item !== 'string' || item.trim() === '') {
      fail(`${path}[${i}]`, 'expected non-empty string');
    }
    result.push(item);
  }
  return result;
}

function isReviewOnTrigger(value: string): value is ReviewOnTrigger {
  return (REVIEW_ON_TRIGGERS as readonly string[]).includes(value);
}

function parseReviewOn(value: unknown, path: string): ReviewOnPolicy {
  if (Array.isArray(value)) {
    const enabled = new Set<ReviewOnTrigger>();
    for (let i = 0; i < value.length; i++) {
      const item = value[i];
      if (typeof item !== 'string' || !isReviewOnTrigger(item)) {
        fail(
          `${path}[${i}]`,
          `expected one of ${REVIEW_ON_TRIGGERS.join(', ')}, got ${String(item)}`,
        );
      }
      enabled.add(item);
    }
    return {
      open: enabled.has('open'),
      ready: enabled.has('ready'),
      push: enabled.has('push'),
      reopen: enabled.has('reopen'),
      manual: enabled.has('manual'),
    };
  }

  const record = expectRecord(value, path);
  const result: ReviewOnPolicy = {
    open: false,
    ready: false,
    push: false,
    reopen: false,
    manual: false,
  };
  for (const trigger of REVIEW_ON_TRIGGERS) {
    if (Object.prototype.hasOwnProperty.call(record, trigger)) {
      result[trigger] = expectBoolean(record[trigger], `${path}.${trigger}`);
    }
  }
  return result;
}

function parseStrictness(value: unknown, path: string): Strictness {
  const raw = expectString(value, path);
  if (!(STRICTNESS_VALUES as readonly string[]).includes(raw)) {
    fail(path, `expected one of ${STRICTNESS_VALUES.join(', ')}, got "${raw}"`);
  }
  return raw as Strictness;
}

function parseContextBudget(value: unknown, path: string): ContextBudget {
  const record = expectRecord(value, path);
  const maxChunkTokens = expectNumber(
    record['max_chunk_tokens'] ?? record['maxChunkTokens'],
    `${path}.max_chunk_tokens`,
  );
  if (maxChunkTokens <= 0) {
    fail(`${path}.max_chunk_tokens`, 'must be a positive number');
  }

  const estimateRaw = record['estimate'];
  if (estimateRaw === undefined) {
    fail(`${path}.estimate`, 'required');
  }
  const estimate = expectString(estimateRaw, `${path}.estimate`);
  if (!(ESTIMATE_VALUES as readonly string[]).includes(estimate)) {
    fail(`${path}.estimate`, `expected one of ${ESTIMATE_VALUES.join(', ')}, got "${estimate}"`);
  }

  return {
    maxChunkTokens,
    estimate: estimate as ContextBudgetEstimate,
  };
}

function parseDecomposition(value: unknown, path: string): DecompositionPolicy {
  const record = expectRecord(value, path);
  const modeRaw = record['mode'];
  if (modeRaw === undefined) {
    fail(`${path}.mode`, 'required');
  }
  const mode = expectString(modeRaw, `${path}.mode`);
  if (!(DECOMPOSITION_MODES as readonly string[]).includes(mode as DecompositionPolicy['mode'])) {
    fail(`${path}.mode`, `expected one of ${DECOMPOSITION_MODES.join(', ')}, got "${mode}"`);
  }
  return { mode: mode as DecompositionPolicy['mode'] };
}

function parsePartialProjectPolicy(value: unknown, path: string): Partial<ProjectPolicy> {
  const record = expectRecord(value, path);
  const result: Partial<ProjectPolicy> = {};

  if (Object.prototype.hasOwnProperty.call(record, 'review_on')) {
    result.reviewOn = parseReviewOn(record['review_on'], `${path}.review_on`);
  } else if (Object.prototype.hasOwnProperty.call(record, 'reviewOn')) {
    result.reviewOn = parseReviewOn(record['reviewOn'], `${path}.reviewOn`);
  }

  if (Object.prototype.hasOwnProperty.call(record, 'strictness')) {
    result.strictness = parseStrictness(record['strictness'], `${path}.strictness`);
  }

  if (Object.prototype.hasOwnProperty.call(record, 'ignored_globs')) {
    result.ignoredGlobs = expectStringArray(record['ignored_globs'], `${path}.ignored_globs`);
  } else if (Object.prototype.hasOwnProperty.call(record, 'ignoredGlobs')) {
    result.ignoredGlobs = expectStringArray(record['ignoredGlobs'], `${path}.ignoredGlobs`);
  }

  if (Object.prototype.hasOwnProperty.call(record, 'context_budget')) {
    result.contextBudget = parseContextBudget(record['context_budget'], `${path}.context_budget`);
  } else if (Object.prototype.hasOwnProperty.call(record, 'contextBudget')) {
    result.contextBudget = parseContextBudget(record['contextBudget'], `${path}.contextBudget`);
  }

  if (Object.prototype.hasOwnProperty.call(record, 'decomposition')) {
    result.decomposition = parseDecomposition(record['decomposition'], `${path}.decomposition`);
  }

  if (Object.prototype.hasOwnProperty.call(record, 'model')) {
    result.model = expectString(record['model'], `${path}.model`);
  }

  if (Object.prototype.hasOwnProperty.call(record, 'profile')) {
    result.profile = expectString(record['profile'], `${path}.profile`);
  }

  return result;
}

function parseProjectPolicy(value: unknown, path: string): ProjectPolicy {
  const partial = parsePartialProjectPolicy(value, path);
  const policy: ProjectPolicy = {
    reviewOn: partial.reviewOn ?? defaultProjectPolicy.reviewOn,
    strictness: partial.strictness ?? defaultProjectPolicy.strictness,
    ignoredGlobs: partial.ignoredGlobs ?? defaultProjectPolicy.ignoredGlobs,
    contextBudget: partial.contextBudget ?? defaultProjectPolicy.contextBudget,
    decomposition: partial.decomposition ?? defaultProjectPolicy.decomposition,
    model: partial.model ?? defaultProjectPolicy.model,
  };
  const profile = partial.profile ?? defaultProjectPolicy.profile;
  if (profile !== undefined) {
    policy.profile = profile;
  }
  return policy;
}

function parseDiscovery(value: unknown, path: string): ExplicitDiscovery {
  const record = expectRecord(value, path);
  const modeRaw = record['mode'];
  if (modeRaw === undefined) {
    fail(`${path}.mode`, 'required');
  }
  const mode = expectString(modeRaw, `${path}.mode`);
  if (mode !== 'explicit') {
    fail(`${path}.mode`, `expected "explicit", got "${mode}"`);
  }

  const projectsRaw = record['projects'];
  if (projectsRaw === undefined) {
    fail(`${path}.projects`, 'required');
  }

  return {
    mode: 'explicit',
    projects: expectStringArray(projectsRaw, `${path}.projects`),
  };
}

function parsePolicyRoot(value: unknown): PolicyConfig {
  const root = expectRecord(value, 'config');

  const defaultsRaw = root['defaults'];
  if (defaultsRaw === undefined) {
    fail('config.defaults', 'required');
  }

  const discoveryRaw = root['discovery'];
  if (discoveryRaw === undefined) {
    fail('config.discovery', 'required');
  }

  const projectsRaw = root['projects'];
  const projects: Record<string, Partial<ProjectPolicy>> = {};
  if (projectsRaw !== undefined) {
    const projectsRecord = expectRecord(projectsRaw, 'config.projects');
    for (const projectPath of Object.keys(projectsRecord)) {
      projects[projectPath] = parsePartialProjectPolicy(
        projectsRecord[projectPath],
        `config.projects.${projectPath}`,
      );
    }
  }

  return {
    defaults: parseProjectPolicy(defaultsRaw, 'config.defaults'),
    projects,
    discovery: parseDiscovery(discoveryRaw, 'config.discovery'),
  };
}

/**
 * Parse and validate a policy YAML document. Pure — no filesystem access.
 * Missing optional fields in `defaults` fall back to {@link defaultProjectPolicy}.
 */
export function parsePolicyConfig(yamlText: string): PolicyConfig {
  let parsed: unknown;
  try {
    parsed = parseYaml(yamlText);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new PolicyConfigError(`invalid YAML: ${message}`);
  }

  if (parsed === null || parsed === undefined) {
    throw new PolicyConfigError('config: expected non-empty YAML document');
  }

  return parsePolicyRoot(parsed);
}

/** Read a policy file from disk and parse it. */
export function loadPolicyConfigFile(filePath: string): PolicyConfig {
  const yamlText = readFileSync(filePath, 'utf8');
  return parsePolicyConfig(yamlText);
}
