# Внешние API

Факты из адаптеров. **Kaiten — строго read-only** под текущим личным токеном (см. `.cursor/rules/kaiten-read-only.mdc`).

---

## GitLab REST v4

Клиент: `GitLabClient` (`src/adapters/vcs/gitlab/client.ts`).

| Параметр | Значение |
| --- | --- |
| Base URL | `{GITLAB_BASE_URL}/api/v4/…` |
| Auth | Header `PRIVATE-TOKEN: {GITLAB_TOKEN}` |
| Pagination | `per_page` (default 50), follow `x-next-page` |
| Rate limit | Retry до 2× на HTTP 429 (`Retry-After` или 1000 ms) |

### `GitLabReader` (`VcsReader` + `VcsMrLister`)

| Операция | Method | Path | Query / body | Использование |
| --- | --- | --- | --- | --- |
| List open MRs | GET | `projects/{id}/merge_requests` | `state=opened` | Poller |
| Get MR | GET | `projects/{id}/merge_requests/{iid}` | — | Context |
| MR diffs | GET | `projects/{id}/merge_requests/{iid}/diffs` | paginated | Changed files list |

### `GitLabCiReader` (`VcsCiReader`)

| Операция | Method | Path | Использование |
| --- | --- | --- | --- |
| Get MR | GET | `projects/{id}/merge_requests/{iid}` | description для nudge про задачу |
| MR pipelines | GET | `projects/{id}/merge_requests/{iid}/pipelines` | выбрать newest по `sha` |
| Pipeline jobs | GET | `projects/{id}/pipelines/{pipelineId}/jobs` | `id`, `when`, `allow_failure`, `status` |
| Job trace | GET | `projects/{id}/jobs/{jobId}/trace` | сырой лог; только при red |

`{id}` — numeric ID или URL-encoded path (`group/sub/project`).

**Не через REST:** unified diff для engine — локально `git diff target...source` после checkout.

**Поля MR:** `title`, `description`, `source_branch`, `target_branch`, `sha` / `diff_refs.head_sha`, `draft`, `state`.

**Diff entry:** `new_path`, `old_path`, `new_file`, `renamed_file`, `deleted_file`, `diff`, `collapsed`, `too_large`.

### `GitLabWriter` (`VcsWriter`, phase 2)

| Операция | Method | Path |
| --- | --- | --- |
| List notes | GET | `projects/{id}/merge_requests/{iid}/notes` |
| Create note | POST | `projects/{id}/merge_requests/{iid}/notes` — `{ body }` |
| Update note | PUT | `projects/{id}/merge_requests/{iid}/notes/{noteId}` — `{ body }` |
| List discussions | GET | `projects/{id}/merge_requests/{iid}/discussions` |
| Get discussion | GET | `projects/{id}/merge_requests/{iid}/discussions/{discussionId}` — assistant: контекст треда |
| Add discussion note | POST | `projects/{id}/merge_requests/{iid}/discussions/{discussionId}/notes` — `{ body }` — ответ assistant |
| Create discussion | POST | `projects/{id}/merge_requests/{iid}/discussions` — `{ body, position? }` |
| Resolve discussion | PUT | `projects/{id}/merge_requests/{iid}/discussions/{id}` — query `resolved` |
| Approve MR | POST | `projects/{id}/merge_requests/{iid}/approve` — `{ sha }` |
| Unapprove MR | POST | `projects/{id}/merge_requests/{iid}/unapprove` |
| Update MR description | PUT | `projects/{id}/merge_requests/{iid}` — `{ description }` — ChatOps rewrite-description |

**Inline `position` (→ GitLab snake_case):** `position_type: 'text'`, `base_sha`, `start_sha`, `head_sha`, `new_path`, optional `old_path`, `new_line`, `old_line`.

MVP `main.ts` writer **не** подключает; publisher — `LogPublisher`.

**Опционально (`GitLabReader`):** `GET /user` — username токена (bot account)
для skip собственных notes в Note Hook (см. ADR 017).

---

## Kaiten REST (read-only)

Клиент: `KaitenHttpClient` (`src/adapters/tracker/kaiten/http.ts`).

| Параметр | Значение |
| --- | --- |
| API prefix | `{KAITEN_BASE_URL}/api/latest` |
| Auth | `Authorization: Bearer {KAITEN_TOKEN}` |
| Methods MVP | **GET only** |

### Endpoints

| Операция | Method | Path | Примечание |
| --- | --- | --- | --- |
| Get card + checklists | GET | `/cards/{id}?additional_card_fields=checklists` | **Единственный рабочий путь** к критериям приёмки |

Константа: `kaitenEndpoints.card(id)` в `src/adapters/tracker/kaiten/endpoints.ts`.

### Известные ограничения (installation `ai-referent.kaiten.ru`)

| Endpoint | Результат |
| --- | --- |
| `GET /cards/:id` (без query) | 200, checklists **не** в теле |
| `GET /cards/:id/checklists` | **405** Method Not Allowed |
| `GET /cards/:id?additional_card_fields=checklists` | 200 + embedded `checklists[]` |

Структура checklist: `{ name, items: [{ text, checked, sort_order }] }`.

### `KaitenTracker.getCard()`

| Домен | Источник JSON |
| --- | --- |
| `id` | аргумент `cardId` |
| `title` | `card.title` |
| `description` | `card.description` |
| `acceptanceCriteria` | flatten всех `checklists[].items[].text` (sort by `sort_order`) |

**Запись в Kaiten запрещена** (comments, links, статусы, чек-листы) до отдельного bot/service token (phase 3+).

---

## Cursor (review engine)

Адаптер: `CliHeadlessEngine` (`src/adapters/engine/cli/`).

| Параметр | Значение |
| --- | --- |
| Binary | `cursor-agent` (override: `CURSOR_AGENT_BIN`) |
| Auth | env `CURSOR_API_KEY` |
| Model default | `cursor-grok-4.6-high-fast` |
| Mode | headless, prompt via stdin |

### CLI flags (фактический вызов)

```text
-p --output-format json --model <model> --force --trust
```

| Flag | Назначение |
| --- | --- |
| `-p` | Print / headless mode |
| `--output-format json` | JSON envelope в stdout |
| `--model` | Slug модели |
| `--force` | Без интерактивных подтверждений |
| `--trust` | Trust workspace |

### Output

1. Agent пишет `findings.json` в workspace
2. stdout — JSON envelope; findings извлекаются из assistant text / fenced block
3. Валидация → `ReviewResult`

Timeout: 600 s (engine default).

SDK/cloud engine — заглушки в `src/adapters/engine/sdk/`, `cloud/` (не MVP).

---

## См. также

- [ports.md](./ports.md)
- [cli.md](./cli.md)
- [finding-schema.md](./finding-schema.md)
- [../05-operations/security.md](../05-operations/security.md)
