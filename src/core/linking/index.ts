/**
 * Barrel for the MR ↔ Kaiten card resolver. See docs/04-architecture/adr/010-mr-kaiten-linking.md §5.
 */
export { resolveCard } from './resolve.ts';
export { defaultLinkResolverConfig } from './config.ts';
export { extractIdFromBranch, extractIdFromText } from './id-extract.ts';
export type { CardLinkInput, LinkResolverConfig, LinkStrategy, ResolveResult } from './types.ts';
