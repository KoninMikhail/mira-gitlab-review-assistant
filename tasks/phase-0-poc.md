# Фаза 0 — PoC (доказать ценность движка)

**Цель фазы:** вручную прогнать ревью реальных MR через `cursor-agent` + Composer 2.5
и оценить качество находок и стоимость. Без очередей, БД, вебхуков и публикации.
**Критерий выхода фазы:** на 5–10 реальных MR находки осмысленны, формат вывода
стабилен, стоимость предсказуема.

Связанные документы: [03-implementation-options](../docs/04-architecture/adr/004-review-engine-port-cli-then-sdk.md),
[07-agent-design](../docs/03-reference/finding-schema.md), [06-integrations](../docs/03-reference/integrations-api.md).

---

### T0.1 — Bootstrap TS-проекта
- **Статус:** DONE _(build/lint/typecheck/test зелёные; @cursor/sdk@^1.0.19; tsconfig strict + allowImportingTsExtensions/rewriteRelativeImportExtensions)._
- **Размер:** S
- **Цель:** каркас репозитория на TypeScript, готовый к разработке.
- **Зависит от:** —
- **Артефакты:** `package.json`, `tsconfig.json`, линтер/форматтер, `src/`, `prompts/`,
  `.env.example`, скрипты `build`/`lint`/`dev`.
- **Шаги:**
  - [ ] Инициализировать Node-проект (Node 20+), `tsconfig` (strict).
  - [ ] Подключить ESLint + Prettier, базовый CI-локально (`npm run lint`).
  - [ ] Добавить `@cursor/sdk` в зависимости (для последующих фаз) — но PoC использует CLI.
  - [ ] Завести структуру каталогов по [13-project-structure](../docs/04-architecture/overview.md) §3.
  - [ ] `.env.example` c `CURSOR_API_KEY`, `GITLAB_BASE_URL`, `GITLAB_TOKEN`, `KAITEN_TOKEN`.
- **DoD:** `npm run build` и `npm run lint` проходят; структура каталогов на месте.
- **Ссылки:** [13](../docs/04-architecture/overview.md).

### T0.2 — Установка и проверка Cursor CLI
- **Статус:** DONE _(установлен v2026.06.19-20-24-33-653a7fb; `composer-2.5` в списке; headless `--output-format json` вернул валидный JSON. ⚠ Windows: root-обёртка `cursor-agent.cmd`/`.ps1` падает («No version directories»), нужно звать `versions\<v>\cursor-agent.cmd`)._
- **Размер:** S
- **Цель:** убедиться, что `cursor-agent` работает headless с Composer 2.5.
- **Зависит от:** `CURSOR_API_KEY`, egress до Cursor API (разрешён, Q-3).
- **Шаги:**
  - [ ] Установить Cursor CLI на машину разработки/сервер.
  - [ ] `cursor-agent --list-models` → подтвердить наличие `composer-2.5`.
  - [ ] Пробный прогон: `cursor-agent -p --output-format json --model composer-2.5 "ответь ok"`.
  - [ ] Зафиксировать версию CLI.
- **DoD:** headless-вызов возвращает валидный JSON; `composer-2.5` доступна.
- **Ссылки:** [03](../docs/04-architecture/adr/004-review-engine-port-cli-then-sdk.md) (Вариант A).

### T0.3 — Минимальный GitLab read-клиент
- **Статус:** CODE DONE / LIVE BLOCKED _(адаптер `GitLabReader` (VcsReader) + юнит-тесты на мок-`fetch` готовы; токен бота `mira_review_bot` работает (whoami ок). Live `getMrContext` не проверен: у бота нет доступных MR → ждёт 🔑P2)._
- **Размер:** M
- **Цель:** получить метаданные MR, список изменённых файлов и diff.
- **Зависит от:** T0.1, доступ read к GitLab.
- **Артефакты:** функция `getMrContext(projectId, mrIid)` → метаданные + changed files.
- **Шаги:**
  - [ ] Реализовать вызовы: детали MR, изменённые файлы (REST/MCP read).
  - [ ] Diff брать **локально** из checkout (`git diff target...source`), а не из API.
  - [ ] Обработать пагинацию/лимиты, бинарные файлы пометить.
- **DoD:** для заданного MR получаем корректные метаданные + список файлов + diff.
- **Ссылки:** [06](../docs/03-reference/integrations-api.md) §2, §6.

### T0.4 — Минимальный Kaiten read-клиент
- **Статус:** DONE _(адаптер `KaitenTracker` (TaskTracker, read-only) + юнит-тесты готовы. Live-баг исправлен: `GET /cards/:id/checklists` отдаёт 405 на ai-referent.kaiten.ru, поэтому критерии читаем встроенными в карточку через `GET /cards/:id?additional_card_fields=checklists` (один запрос). Чек-листы и пункты приходят в произвольном порядке — сортируем по `sort_order`, затем нормализуем в плоский `string[]`. Отдельный вызов чек-листов убран.)._
- **Размер:** S
- **Цель:** получить описание карточки и критерии приёмки.
- **Зависит от:** T0.1, токен Kaiten.
- **Артефакты:** `getCard(cardId)` → заголовок, описание, чек-листы (критерии).
- **Шаги:**
  - [x] Чтение карточки с встроенными чек-листами (`GET /cards/:id?additional_card_fields=checklists`).
  - [x] Нормализовать критерии приёмки в простой список строк (сортировка по `sort_order`).
- **DoD:** по ID карточки возвращаются заголовок/описание/критерии.
- **Ссылки:** [06](../docs/03-reference/integrations-api.md) §4.

### T0.5 — Резолвер связи MR ↔ Kaiten (минимальный)
- **Статус:** DONE _(resolveCard: стратегии description/title → branch-regex, фолбэк «не найдено»; юнит-тесты на фейковом трекере. Дефолты: branch `^[^/]+\/(\d+)(?:-.*)?$`, описание — Kaiten-URL/`KAITEN-<id>`/`#<id>`)._
- **Размер:** S
- **Цель:** определить карточку по ветке/описанию MR.
- **Зависит от:** T0.3, T0.4.
- **Артефакты:** `resolveCard(mr)` со стратегиями branch-regex и description-pattern.
- **Шаги:**
  - [ ] Разбор ID карточки из имени ветки (`branch_regex`) и описания MR.
  - [ ] Фолбэк: «карточка не найдена» → деградация (ревью по diff).
- **DoD:** на тестовых MR карточка определяется по ветке/описанию; фолбэк работает.
- **Ссылки:** [06](../docs/03-reference/integrations-api.md) §5.

### T0.6 — Промпт v1 + JSON-схема находок
- **Статус:** DONE _(`prompts/review.v1.md`, `schema/findings.schema.json` (draft 2020-12), валидатор на ajv в `src/core/findings/` + юнит-тесты. Канон зафиксирован по docs/03-reference/finding-schema §3: верхний уровень `{verdict, summary, requirements_coverage?, findings, degradations?}`, severity `blocker|major|minor|nit`, поля находки `category`/`file_path`/`line_start`/`message`/`confidence`. Схема — внешний контракт (snake_case), `validateFindings` валидирует и маппит в camelCase-домен (`ReviewResult`/`Finding`))._
- **Размер:** M
- **Цель:** шаблон промпта-ревьюера и строгая схема вывода.
- **Зависит от:** T0.1.
- **Артефакты:** `prompts/review.v1.md`, `schema/findings.schema.json`.
- **Шаги:**
  - [ ] Перенести скелет промпта из [07](../docs/03-reference/finding-schema.md) §4 (роль, задача, шаги, схема).
  - [ ] Описать JSON Schema находок ([07](../docs/03-reference/finding-schema.md) §3) и валидатор.
  - [ ] Инструкция агенту: записать `findings.json` + продублировать fenced-JSON.
- **DoD:** промпт версионируется; вывод валидируется схемой; невалидный → понятная ошибка.
- **Ссылки:** [07](../docs/03-reference/finding-schema.md) §3–§4.

### T0.7 — PoC-раннер и оценка
- **Статус:** CODE DONE / LIVE BLOCKED _(раннер `poc --project <id> --mr <iid>` собран и протестирован (51/51 юнит-тестов, typecheck/lint/build зелёные). Движок `CliHeadlessEngine` (порт `ReviewEngine`) рендерит `prompts/review.v1.md`, зовёт `cursor-agent` headless и валидирует находки. Эфемерный checkout + локальный diff в `src/core/context/checkout.ts`, оркестрация в `src/entrypoints/cli/poc.ts` (флаг `--no-engine` прогоняет всё до вызова агента). Прогон на 5–10 реальных MR ждёт 🔑P2 — у бота нет доступных репозиториев/MR.)._
- **Размер:** M
- **Цель:** связать всё воедино и прогнать на 5–10 реальных MR.
- **Зависит от:** T0.2–T0.6.
- **Артефакты:** `src/entrypoints/cli/poc.ts` — `poc --project <id> --mr <iid>`; `src/adapters/engine/cli/` (`CliHeadlessEngine`); `src/core/context/checkout.ts`.
- **Шаги:**
  - [x] Подготовить эфемерный checkout ветки MR (partial clone) + локальный diff (`git diff target...source`).
  - [x] Собрать контекст (diff + карточка + критерии) → `.mira/context.json`.
  - [x] Запустить `cursor-agent -p --output-format json --model composer-2.5 --force --trust` (через `CliHeadlessEngine`).
  - [x] Распарсить и провалидировать `findings.json`; вывести сводку в консоль.
  - [ ] Прогнать на 5–10 MR; собрать заметки по качеству и расходу токенов. _(ждёт 🔑P2)_
- **DoD:** на выборке MR раннер стабильно выдаёт валидные находки; есть отчёт
  «качество/стоимость» и решение о переходе к MVP.
- **Ссылки:** [05](../docs/04-architecture/review-pipeline.md) §2–§4, [08](../docs/05-operations/deployment.md) §6.

---

## Итог фазы 0
Подтверждённая ценность движка, зафиксированные промпт v1 и схема находок,
понимание стоимости. Готовность начинать MVP (Фаза 1).
