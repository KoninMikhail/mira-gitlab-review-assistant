/**
 * Project policy types, defaults, and merge/resolution. See docs/03-reference/policy-config.md §4.
 */
export { defaultProjectPolicy } from './defaults.ts';
export { mergeProjectPolicy, resolvePolicy } from './merge.ts';
export type {
  ContextBudget,
  ContextBudgetEstimate,
  DecompositionPolicy,
  ExplicitDiscovery,
  PolicyConfig,
  ProjectPolicy,
  ReviewOnPolicy,
  Strictness,
} from './types.ts';
