/**
 * Default resolver configuration. Encodes the team convention from
 * docs/04-architecture/adr/010-mr-kaiten-linking.md §5 (Q-2): card id in the branch name + an explicit
 * card reference in the MR description/title. `branchRegex` is meant to be
 * overridden per team if their branch naming differs.
 */
import type { LinkResolverConfig } from './types.ts';

export const defaultLinkResolverConfig: LinkResolverConfig = {
  // `feature/4567-some-slug`, `bugfix/4567`, etc. → capture group 1 = "4567".
  branchRegex: /^[^/]+\/(\d+)(?:-.*)?$/,
  descriptionPatterns: [
    // Kaiten card URL: `.../cards/4567` or `.../card/4567`.
    /\/cards?\/(\d+)/i,
    // Explicit key form: `KAITEN-4567`.
    /KAITEN-(\d+)/i,
    // Short hash form: `#4567`.
    /#(\d+)\b/,
  ],
};
