/**
 * Centralized Kaiten REST endpoint paths. All paths are relative to the API
 * base (`${baseUrl}${API_BASE_PATH}`).
 *
 * Live investigation (🔑P5, installation `ai-referent.kaiten.ru`, 2026-06):
 * - `GET /cards/:id` → 200. Acceptance criteria live in checklists, but a plain
 *   card response does not reliably embed them.
 * - `GET /cards/:id/checklists` → 405 Method Not Allowed (the dedicated
 *   sub-resource is not exposed on this installation; the Kaiten MCP's
 *   `kaiten_get_card_checklists` fails the same way for the same reason).
 * - `GET /cards/:id?additional_card_fields=checklists` → 200 with the card plus
 *   an embedded `checklists` array (`{ name, items: [{ text, checked,
 *   sort_order }] }`). This is the only working read path, so the card GET
 *   always requests checklists inline and there is no separate checklists call.
 */

/** Versioned API prefix appended to the configured Kaiten base URL. */
export const API_BASE_PATH = '/api/latest';

export const kaitenEndpoints = {
  /**
   * GET card details with checklists embedded via `additional_card_fields`.
   * The query param is required to get acceptance criteria on installations
   * where the dedicated `/checklists` sub-resource returns 405 (see file note).
   */
  card: (id: string): string =>
    `/cards/${encodeURIComponent(id)}?additional_card_fields=checklists`,
} as const;
