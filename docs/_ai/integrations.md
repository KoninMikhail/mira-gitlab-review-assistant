# Integrations

Подробности — [`docs/03-reference/integrations-api.md`](../03-reference/integrations-api.md). Здесь — выжимка
с акцентом на доступы и ограничения, которые агент должен помнить всегда.

## GitLab (self-hosted, `gitlab.ai-referent.ru`)

- **Read** (контекст MR, diff, список открытых MR) — адаптер
  `src/adapters/vcs/gitlab/` (`GitLabReader`, реализует `VcsReader` + `VcsMrLister`).
- **Write** (заметки/дискуссии в MR + консультативный Approve при `verdict: ok`) —
  **фаза 2**, под **выделенным bot-аккаунтом** (`mira_review_bot`, id=30) через
  REST. Approve не required для merge (ADR 016). Живая публикация — флаг
  `MIRA_PUBLISHER=gitlab`.
- 🔑**P2 (блокер):** боту не выданы доступы к пилотным репозиториям → живые
  прогоны и публикация невозможны, поллер простаивает.
- Связь MR ↔ задача: ID карточки Kaiten в имени ветки и/или ссылке в описании MR
  (резолвер — `src/core/linking/`).

## Kaiten — СТРОГО READ-ONLY

- Адаптер `src/adapters/tracker/kaiten/` (`KaitenTracker`, реализует `TaskTracker`):
  читает карточку, описание, **критерии приёмки**.
- `KAITEN_TOKEN` — **личный токен** пользователя (@dev.konin), не сервис-аккаунт.
  **Любая запись запрещена** (comments, external links, статусы, чек-листы,
  create/update/delete). См. правило `kaiten-read-only.mdc`.
- Критерии читаются встроенно: `GET /cards/:id?additional_card_fields=checklists`
  (отдельный `GET /cards/:id/checklists` отдаёт 405), сортировка по `sort_order`.
- Запись-обратная-связь в Kaiten — только после отдельного сервис-аккаунта/бот-токена
  (фаза 3+), не под личным токеном.

## Cursor (движок ревью)

- `CURSOR_API_KEY` с доступом к модели `cursor-grok-4.6-high-fast`.
- MVP: CLI headless (`cursor-agent -p --output-format json`) — адаптер
  `src/adapters/engine/cli/`. Прод-цель: `@cursor/sdk` local runtime (фаза 3).
- **Egress:** код MR уходит в Cursor API для работы модели — разрешено политикой
  ИБ (зафиксировано). См. [`docs/05-operations/security.md`](../05-operations/security.md).

## MCP-серверы (для агента в этом репо)

Доступны MCP `user-gitlab-mcp` и `user-kaiten-mcp`. Для Kaiten — использовать
**только** инструменты чтения (`kaiten_get_*`/`kaiten_list_*`/`kaiten_search_*`).
