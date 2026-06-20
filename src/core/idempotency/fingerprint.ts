/**
 * Canonical finding fingerprints for dedup and idempotent publication.
 * Anchored on category, file path, and message — not line numbers.
 * See docs/04-architecture/review-pipeline.md §6.
 */
import { createHash } from 'node:crypto';

import type { Finding } from '../domain/index.ts';

/** SHA-256 hex digest of `category|filePath|message`. */
export function findingFingerprint(finding: Finding): string {
  const payload = `${finding.category}|${finding.filePath}|${finding.message}`;
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}
