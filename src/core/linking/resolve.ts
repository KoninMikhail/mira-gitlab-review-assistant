/**
 * Multi-strategy MR ↔ Kaiten card resolver (docs/04-architecture/adr/010-mr-kaiten-linking.md §5).
 *
 * Precedence (most reliable first):
 *   1. explicit card reference in the MR description or title;
 *   2. card id parsed from the branch name.
 * When an id is extracted but `getCard` fails, we degrade gracefully to
 * "not found" (review by diff without a task) instead of crashing.
 */
import type { TaskTracker } from '../ports/index.ts';
import { defaultLinkResolverConfig } from './config.ts';
import { extractIdFromBranch, extractIdFromText } from './id-extract.ts';
import type { CardLinkInput, LinkResolverConfig, LinkStrategy, ResolveResult } from './types.ts';

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Fetch a card by id, degrading to a `{ found: false }` result on failure. */
async function fetchCard(
  tracker: TaskTracker,
  id: string,
  strategy: LinkStrategy,
): Promise<ResolveResult> {
  try {
    const card = await tracker.getCard(id);
    return { found: true, card, strategy };
  } catch (err) {
    return {
      found: false,
      reason: `card "${id}" referenced via ${strategy} but lookup failed: ${errorMessage(err)}`,
    };
  }
}

/**
 * Resolve the Kaiten card linked to an MR. Returns a discriminated union so the
 * caller can branch on `found` and, when degraded, surface a clear `reason`.
 */
export async function resolveCard(
  input: CardLinkInput,
  tracker: TaskTracker,
  config: LinkResolverConfig = defaultLinkResolverConfig,
): Promise<ResolveResult> {
  const descriptionPatterns =
    config.descriptionPatterns ?? defaultLinkResolverConfig.descriptionPatterns ?? [];

  // Strategy 1 — explicit reference in description or title (most reliable).
  const text = `${input.title}\n${input.description}`;
  const descriptionId = extractIdFromText(text, descriptionPatterns);
  if (descriptionId !== undefined) {
    return await fetchCard(tracker, descriptionId, 'description');
  }

  // Strategy 2 — card id embedded in the branch name.
  const branchId = extractIdFromBranch(input.sourceBranch, config.branchRegex);
  if (branchId !== undefined) {
    return await fetchCard(tracker, branchId, 'branch');
  }

  // Degradation: no id anywhere → review by diff without a task.
  return { found: false, reason: 'card not found' };
}
