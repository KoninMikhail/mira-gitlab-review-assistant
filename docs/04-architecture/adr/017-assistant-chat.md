# 017. Conversational assistant — отдельный путь от ревью

- Статус: Принято (Accepted)
- Дата: 2026-09
- Scope: маршрутизация Note Hook и split assistant vs `ReviewEngine`
- Контекст-ссылки: [../../01-concepts/overview.md](../../01-concepts/overview.md),
  [../triggers.md](../triggers.md), [013-layered-review-guidance.md](./013-layered-review-guidance.md)

## Контекст

После публикации ревью разработчики уточняют находки и задают вопросы по MR в
комментариях. Нужен диалог без повторного `@mira review`, но без смешения с
структурированным ревью (`findings.json`, идемпотентность `StateStore`).

## Решение

**Детерминированный роутер** (`classifyNote` в `core/chatops/`) — без LLM-классификации.

1. **Команды (whitelist)** `@mira review` / алиасы «ревью» / `@mira ignore` /
   rewrite-description — **всегда** приоритет над диалогом (ADR 018).
2. **Тред Mira** — первый note с `<!-- mira:finding:… -->` или `<!-- mira:summary -->`:
   любой ответ человека → assistant в **том же** discussion; `@mira` не нужен.
3. **Корневой комментарий** с `@mira` (не команда) → Q&A по MR/задаче; ответ в
   **тот же** discussion.
4. **Assistant** — отдельный порт `AssistantEngine.reply(AssistantRequest)`;
   промпт `prompts/assistant.v1.md` (игривая русская «она», как presence acks),
   **не** `review.v1.md`. Контекст: `ContextBuilder` checkout → engine →
   `VcsWriter.addDiscussionNote` с `<!-- mira:reply -->`.
5. **Не ReviewJob**: без `Queue` / `seen` / `record`. Dry-run (`MIRA_PUBLISHER=log`):
   прогон engine + лог, без POST.
6. **Skip**: system notes, edits, notes бота (username), собственные ответы с
   `<!-- mira:reply -->`. Вне scope: `@mira kill`. Правка description MR — только
   команда rewrite-description (ADR 018), не свободный чат.

## Альтернативы

| Вариант | Почему не выбран |
| --- | --- |
| LLM-классификатор intent | Непредсказуемость, latency, стоимость на каждый note |
| `@mira` обязателен в треде | Лишний шум; тред уже «принадлежит» Mira |
| Тот же промпт, что ревью | Английский structured output; другой tone и задача |
| Assistant как `ReviewJob` | Ложная идемпотентность; блокирует уточняющие вопросы |

## Последствия

- Note Hook передаёт `discussion_id`; `VcsWriter.getDiscussion` / `addDiscussionNote`.
- Webhook handler: command → enqueue; chat → assistant path (parallel review pipeline).
- Тесты роутера — pure `core/chatops/`; assistant — fake ports.

## References

- [../triggers.md](../triggers.md) — ChatOps и таблица маршрутизации
- [013-layered-review-guidance.md](./013-layered-review-guidance.md)
- [018-chatops-aliases-and-mr-description.md](./018-chatops-aliases-and-mr-description.md)
