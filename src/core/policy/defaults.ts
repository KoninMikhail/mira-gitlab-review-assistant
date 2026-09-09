/**
 * Default project policy applied when YAML omits fields or a project has no
 * override. Matches docs/03-reference/policy-config.md §4.1 and docs/04-architecture/triggers.md defaults
 * (`review_on: [open, ready, manual]`).
 */
import type { ProjectPolicy } from './types.ts';

/** Grok 4.6 Fast; effort is the model default (not pinned in the slug). */
export const DEFAULT_CURSOR_MODEL = 'cursor-grok-4.6[fast=true]';

export const defaultProjectPolicy: ProjectPolicy = {
  reviewOn: {
    open: true,
    ready: true,
    push: false,
    reopen: false,
    manual: true,
  },
  strictness: 'balanced',
  ignoredGlobs: ['**/*.lock', '**/package-lock.json', '**/dist/**', '**/*.min.js'],
  contextBudget: {
    maxChunkTokens: 60_000,
    estimate: 'bytes',
  },
  decomposition: {
    mode: 'single',
  },
  model: DEFAULT_CURSOR_MODEL,
};
