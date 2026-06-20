/**
 * Types for the MR ↔ Kaiten card resolver (see docs/04-architecture/adr/010-mr-kaiten-linking.md §5).
 * The resolver input is intentionally a small, local shape — it does NOT couple
 * to the full `MrContext` port so it stays trivial to construct and unit-test.
 */
import type { TaskCard } from '../domain/index.ts';

/** Minimal MR metadata the resolver needs to find a linked card. */
export interface CardLinkInput {
  title: string;
  description: string;
  sourceBranch: string;
}

/**
 * Tuning for the resolver. Patterns must expose the card id in capture group 1.
 * A string is compiled to a `RegExp`; a `RegExp` is used as-is (the global flag
 * is ignored so matching stays stateless).
 */
export interface LinkResolverConfig {
  /** Branch pattern, e.g. `feature/<cardId>-slug`. Capture group 1 = card id. */
  branchRegex: RegExp | string;
  /** Description/title patterns (Kaiten URL, `#id`, `KAITEN-id`, ...). */
  descriptionPatterns?: (RegExp | string)[];
}

/** Which strategy produced the match (most reliable first). */
export type LinkStrategy = 'description' | 'branch';

/** Outcome of resolution: either a card was found, or we degrade to diff-only. */
export type ResolveResult =
  | { found: true; card: TaskCard; strategy: LinkStrategy }
  | { found: false; reason: string };
