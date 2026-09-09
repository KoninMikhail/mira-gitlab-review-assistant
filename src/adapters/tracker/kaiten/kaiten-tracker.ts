/**
 * `TaskTracker` adapter backed by the Kaiten REST API.
 *
 * Design note: `docs/03-reference/integrations-api.md` (§4, §7) references Kaiten access via
 * MCP tools (`kaiten_get_card`, `kaiten_get_card_checklists`) and names the
 * canonical port impl `KaitenMcpTracker`. The Kaiten MCP is a wrapper over this
 * same REST API. For the PoC we implement a REST-backed `KaitenTracker`
 * (deterministic, trivially unit-testable, no MCP runtime dependency) behind
 * the `TaskTracker` port so the MCP-backed variant can be swapped in later
 * without touching `core`.
 */
import type { TaskCard } from '../../../core/domain/index.ts';
import type { TaskTracker } from '../../../core/ports/index.ts';
import { kaitenEndpoints } from './endpoints.ts';
import { KaitenHttpClient } from './http.ts';
import type { FetchLike } from './http.ts';

/** Raw Kaiten card shape (only the fields we consume). */
interface KaitenCard {
  id?: number | string;
  title?: string;
  description?: string;
  /**
   * Checklists embedded via `?additional_card_fields=checklists` (the only
   * working read path on `ai-referent.kaiten.ru`; see `endpoints.ts`).
   */
  checklists?: KaitenChecklist[];
}

interface KaitenChecklist {
  id?: number | string;
  name?: string;
  /** Kaiten orders checklists by `sort_order`, not array position. */
  sort_order?: number;
  items?: KaitenChecklistItem[];
}

interface KaitenChecklistItem {
  id?: number | string;
  text?: string;
  checked?: boolean;
  /** Kaiten orders items by `sort_order`, not array position. */
  sort_order?: number;
}

export interface KaitenTrackerOptions {
  baseUrl: string;
  token: string;
  /** Injectable transport for tests; defaults to the global `fetch`. */
  fetch?: FetchLike;
}

export class KaitenTracker implements TaskTracker {
  private readonly http: KaitenHttpClient;

  constructor(options: KaitenTrackerOptions) {
    this.http = new KaitenHttpClient(
      options.fetch === undefined
        ? { baseUrl: options.baseUrl, token: options.token }
        : {
            baseUrl: options.baseUrl,
            token: options.token,
            fetch: options.fetch,
          },
    );
  }

  /** Rotate the Kaiten Bearer token used on subsequent reads. */
  setToken(token: string): void {
    this.http.setToken(token);
  }

  async getCard(cardId: string): Promise<TaskCard> {
    const card = await this.http.get<KaitenCard>(kaitenEndpoints.card(cardId));

    return {
      id: cardId,
      title: normalizeText(card.title),
      description: normalizeText(card.description),
      acceptanceCriteria: flattenAcceptanceCriteria(card.checklists),
    };
  }
}

function normalizeText(value: string | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** Ascending comparator on `sort_order`; missing values sort first (stable). */
function bySortOrder(a: { sort_order?: number }, b: { sort_order?: number }): number {
  return (a.sort_order ?? 0) - (b.sort_order ?? 0);
}

/**
 * Flattens checklist items across all checklists into a plain list of trimmed,
 * non-empty acceptance-criteria strings. Kaiten returns checklists and items in
 * arbitrary array order, so both are sorted by `sort_order` to match the order
 * shown in the Kaiten UI before flattening.
 */
function flattenAcceptanceCriteria(checklists: KaitenChecklist[] | undefined): string[] {
  const out: string[] = [];
  for (const checklist of [...(checklists ?? [])].sort(bySortOrder)) {
    for (const item of [...(checklist.items ?? [])].sort(bySortOrder)) {
      const text = normalizeText(item.text);
      if (text.length > 0) {
        out.push(text);
      }
    }
  }
  return out;
}
