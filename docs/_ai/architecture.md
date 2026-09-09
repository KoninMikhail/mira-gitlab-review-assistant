# Architecture (выжимка)

Полная версия с диаграммами и раскладкой по коду — [`docs/04-architecture/overview.md`](../04-architecture/overview.md).
Решения (ADR) — [`docs/04-architecture/adr/`](../04-architecture/adr/README.md).

## Главный инвариант: гексагон (ports & adapters)

```
entrypoints ──┐
              ├──> core (domain + ports + orchestrator + ...)
adapters ─────┘         ▲
   реализуют ───────────┘ ports (интерфейсы)
```

- **`core`** не знает про GitLab/Kaiten/Cursor — только доменные типы и **порты**.
- **`adapters`** реализуют порты под конкретные системы (тонкие, без бизнес-логики).
- **`entrypoints`** — единственный **composition root**: связывают core + адаптеры
  по конфигу и поднимают процесс роли (`src/entrypoints/main.ts`).
- Зависимости направлены **внутрь, к ядру**. Менять адаптер — не трогая core.

→ Новый код размещай по этому правилу: логика ревью — в `core/*`; интеграция с
внешней системой — новый адаптер в `adapters/*`, реализующий порт из `core/ports`.

## Порты (контракты core) — `src/core/ports/index.ts`

`VcsReader`, `VcsMrLister`, `VcsCiReader`, `VcsWriter`, `TaskTracker`, `ReviewEngine`,
`AssistantEngine`, `Publisher`, `Queue`, `StateStore`, `Clock`. Доменные типы — `src/core/domain/index.ts`
(`ReviewJob`/`JobKey`, `ReviewContext`, `ReviewUnit`, `Finding`, `ReviewResult`,
`TaskCard`, …).

## Правила ревью: 3 слоя guidance

Что ревьюер ищет — **трёхслойно** (ADR 013, [`docs/03-reference/review-profiles.md`](../03-reference/review-profiles.md)):

- **A — базовый промпт** `prompts/review.v1.md` (роль + универсальные принципы);
- **B — стек-профиль** `profiles/<name>.md`, выбирается полем `profile` в policy,
  инжектится в `{{profile_guidance}}`; отпечаток (`<name>@<sha8>`) подмешан в
  `promptVersion` ключа идемпотентности (правка профиля → переревью);
- **C — repo-local** `.cursor/rules`/`AGENTS.md` — движок читает сам из чекаута MR.

Механика (триггеры/строгость/globs/бюджет/модель) — в YAML policy; «что искать» —
в Markdown (профили), не в JSON.

## Пайплайн ревью (на один `ReviewJob`)

`createReviewPipeline` в `src/core/orchestrator/`:

1. `resolvePolicy(projectId)` — политика проекта (включён ли, фильтры, строгость,
   `profile`); отпечаток профиля → `promptVersion` ключа.
2. **Presence / CI classify** (если есть `VcsCiReader`): ждать обязательный CI,
   игривый ack; исход CI фолдится в `promptVersion` (`+ci.red` / `+ci.green`).
   `@mira review` не ждёт. Красный CI — доп. контекст ревью (ADR 015).
   См. [`docs/04-architecture/presence-and-ci-wait.md`](../04-architecture/presence-and-ci-wait.md).
3. Идемпотентность: `StateStore.seen(ReviewKey)` — этот SHA+исход CI уже ревьюился?
   Автотриггеры (`open`/`poll`/`push`/…) пропускают; `@mira review` (`chatops`) и
   CLI (`manual`) гоняют заново, пишут игривый `rereview` ack в summary и
   перезаписывают запись.
4. `ContextBuilder.build(job)` → `{ context, workspaceDir, cleanup }` — эфемерный
   checkout ветки MR + diff + связанная карточка Kaiten; pipeline добавляет `ci`.
5. **Partition** (`core/partition`): режет на `ReviewUnit` (MVP-режим `single`:
   фильтр ignored/binary, чанкинг по байт-бюджету на границах файлов).
6. `ReviewEngine.review(unit.context)` по юнитам (CLI headless).
7. **Aggregate** (`core/aggregate`): дедуп находок, худший вердикт/статус критерия.
8. **Normalize** (`core/normalize`): glob-фильтры → пороги строгости → дедуп →
   сорт → cap.
9. `Publisher.publish(...)` — `LogPublisher` (dry-run) или `GitLabPublisher`
   (комментарии + консультативный Approve при `verdict: ok`, ADR 016).
10. `StateStore.record(key, result)` — фиксация + метрики; `cleanup()` воркспейса.

Деталь пайплайна и идемпотентности — [`docs/04-architecture/review-pipeline.md`](../04-architecture/review-pipeline.md).
Декомпозиция/бюджет контекста — [`docs/04-architecture/decomposition-context-budget.md`](../04-architecture/decomposition-context-budget.md).

## Assistant (после review pipeline, отдельный путь)

Note Hook → `classifyNote` (`core/chatops/`): команды `@mira review` (и алиасы
«ревью»), `@mira ignore`, rewrite-description → очередь / mute / PATCH
описания MR; диалог в треде Mira или корневой `@mira` → **не** `ReviewJob`.
`ContextBuilder.build` → `AssistantEngine.reply` (`prompts/assistant.v1.md`) →
`VcsWriter.addDiscussionNote` (маркер `<!-- mira:reply -->`); rewrite-description
ещё вызывает `updateMrDescription`. Dry-run — лог без POST/PUT.
ADR: [`docs/04-architecture/adr/017-assistant-chat.md`](../04-architecture/adr/017-assistant-chat.md),
[`018-chatops-aliases-and-mr-description.md`](../04-architecture/adr/018-chatops-aliases-and-mr-description.md).

## Процессы (роли из одного образа)

`ROLE` выбирает поведение `entrypoints/main.ts`:
`all` (default: poller+worker+healthz+`/admin/secrets`) | `api` (`/healthz`, `/admin/secrets`, webhook) |
`poller` (discovery открытых MR → enqueue) | `worker` (консьюмер очереди).

Токены Cursor/GitLab/Kaiten можно сменить без рестарта (`PUT /admin/secrets`, ADR 019).
`CURSOR_API_KEY` может содержать пул ключей с failover (ADR 020).

## Ключевые принципы реализации

- Ядро тестируется **без сети**: fake-порты `src/core/ports/fakes.ts` + co-located `*.test.ts`.
- Stateless worker: всё состояние — в `StateStore` (SQLite).
- Эфемерные изолированные воркспейсы; деградация, а не отказ (нет карточки →
  ревьюим по diff, помечаем degradation).
- Версионирование поведения: `prompt_version`/`partition_version` пишутся в store
  для воспроизводимости и переревью при bump.
- Конфиг типизирован и валидируется на старте (ранний fail).
