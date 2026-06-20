/** Barrel for findings normalization (filters, thresholds, dedup, cap). */
export { DEFAULT_MAX_FINDINGS, normalizeFindings } from './normalize.ts';
export type {
  NormalizedFinding,
  NormalizeDropped,
  NormalizeOptions,
  NormalizeResult,
} from './normalize.ts';
