# Локальная разработка

Как итерировать по коду Mira Review Bot: проверки качества, тесты без внешних систем, запуск entrypoints и размещение нового кода в гексагональной архитектуре.

Быстрый старт (clone, env) — [00-onboarding](../00-onboarding/README.md).

---

## Команды из `package.json`

| Команда | Что делает |
| --- | --- |
| `npm run typecheck` | `tsc --noEmit` для `src/` (без `*.test.ts`) + `tsconfig.test.json` |
| `npm run lint` | oxlint |
| `npm run lint:fix` | oxlint с автофиксом |
| `npm run format` | oxfmt (исключает `*.md`) |
| `npm run format:check` | проверка форматирования без записи |
| `npm test` | `node --test src/**/*.test.ts` — тесты **рядом с модулем** (`*.test.ts`) |
| `npm run build` | `tsc` → `dist/` |
| `npm start` | `node dist/entrypoints/main.js` (после `build`) |
| `npm run start:ts` | `node src/entrypoints/main.ts` — основной сервис без сборки |
| `npm run dev` | `node --watch src/entrypoints/cli/index.ts` — watch на CLI entrypoint |

**Рекомендуемый минимум перед коммитом:**

```bash
npm run typecheck && npm run lint && npm test
```

(Согласовано с `AGENTS.md` и onboarding.)

---

## Запуск процессов локально

### CLI (PoC, отладка одного MR)

```bash
# watch на cli/index.ts — перезапуск при изменениях
npm run dev

# с аргументами subcommand
npm run dev -- poc --project <id> --mr <iid> --no-engine
```

Или без watch:

```bash
node src/entrypoints/cli/index.ts poc --project <id> --mr <iid>
```

Подробности флагов — [run-review-poc.md](./run-review-poc.md), [cli.md](../03-reference/cli.md).

### Основной сервис (poller + worker + healthz)

```bash
# .env с CURSOR_API_KEY, GITLAB_*, KAITEN_*
# опционально: MIRA_POLICY_CONFIG, ROLE, MIRA_DB_PATH, WORKSPACE_ROOT, …
npm run start:ts
```

- `ROLE` — `all` (default) \| `poller` \| `worker` \| `api` (`src/entrypoints/main.ts`).
- Без `MIRA_POLICY_CONFIG` poller не видит pilot-проекты — см. [configure-project-policy.md](./configure-project-policy.md).
- Publisher сейчас `LogPublisher` — находки только в структурный лог (dry-run).

После `npm run build`:

```bash
npm start
```

Healthcheck: `http://localhost:8080/healthz` (порт — `HEALTH_PORT`, default 8080).

`npm run start:ts` подхватывает `.env` из cwd (не нужно экспортировать переменные вручную). Сменить ключ без рестарта:

```bash
curl -sS -X PUT http://127.0.0.1:8080/admin/secrets \
  -H "content-type: application/json" \
  -d "{\"CURSOR_API_KEY\":\"key_...\"}"
```

Либо поправить `.env` и `POST /admin/secrets/reload`. Подробности и auth — [environment.md](../03-reference/environment.md), [ADR 019](../04-architecture/adr/019-live-secret-rotation.md).

---

## Тесты и `src/core/ports/fakes.ts`

Тесты — **Node.js native test runner** (`node --test`), файлы **`src/<module>/*.test.ts`** рядом с реализацией, конфиг типов тестов — `tsconfig.test.json`.

Модуль `src/core/ports/fakes.ts` — in-memory реализации **всех портов** из `src/core/ports/index.ts` для unit-тестов core **без сети, git и реального engine**:

| Класс | Порт | Назначение |
| --- | --- | --- |
| `FakeVcsReader` | `VcsReader` | Seed MR contexts; отклоняет неизвестные `(project, mr)` |
| `FakeVcsWriter` | `VcsWriter` | Записывает notes/discussions для тестов publisher |
| `FakeIgnoreStore` | `IgnoreStore` | Mute finding fingerprints |
| `FakeTaskTracker` | `TaskTracker` | Seed карточек Kaiten |
| `FakeReviewEngine` | `ReviewEngine` | Фиксированный `ReviewResult`, записывает полученные контексты |
| `InMemoryQueue` | `Queue` | FIFO + dedup по `JobKey` |
| `InMemoryStateStore` | `StateStore` | Идемпотентность по `ReviewKey` |
| `FakeClock` | `Clock` | Детерминированное время |

Паттерн: тестируем `core/orchestrator`, `poller`, `poc` (через injected deps) с фейками вместо адаптеров GitLab/Kaiten/Cursor.

Пример прогона одного файла:

```bash
node --test src/core/orchestrator/pipeline.test.ts
```

---

## Где добавлять новый код (гексагон)

Зависимости направлены **внутрь, к `core`**:

```text
entrypoints ──> core (domain, ports, orchestrator, …)
adapters ─────> core (реализуют ports)
```

| Что добавляете | Куда |
| --- | --- |
| Доменный тип, структура находки | `src/core/domain/` |
| Новый внешний контракт | `src/core/ports/index.ts` |
| Логика ревью (partition, normalize, linking, policy) | `src/core/<module>/` |
| Интеграция с GitLab / Kaiten / Cursor / SQLite | `src/adapters/<system>/` |
| Связывание core + adapters, HTTP, CLI | `src/entrypoints/` — **единственный composition root** для сервиса (`main.ts`) |
| Промпт ревью | `prompts/review.v1.md` (+ bump `prompt_version` в pipeline) |
| JSON-схема находок | `schema/findings.schema.json` |
| Unit-тест | `src/<module>/*.test.ts` рядом с кодом; фейки — `src/core/ports/fakes.ts` |

**Не** тянуть GitLab/Kaiten/Cursor из `core/*`. **Не** размазывать wiring по адаптерам.

Выжимка архитектуры — [overview.md](../04-architecture/overview.md), карта репо — `docs/_ai/codebase-map.md`.

---

## Стек и ограничения

- **TypeScript ESM**, Node **≥ 24** — `.ts` запускается нативно (`"type": "module"`).
- Импорты — **относительные с расширением `.ts`** (`import … from './foo.ts'`).
- Kaiten под текущим токеном — **строго read-only** (никаких write API в адаптере).

---

## Типичный dev loop

1. Ветка + `.env` по `.env.example`.
2. Изменения в `src/` (включая co-located `*.test.ts`).
3. `npm run typecheck && npm run lint && npm test`.
4. Для функциональной проверки:
   - один MR — `node src/entrypoints/cli/index.ts poc …`;
   - полный цикл — `MIRA_POLICY_CONFIG=… npm run start:ts`.
5. Перед push — снова typecheck + lint + test.

---

## Дальше

- PoC одного MR — [run-review-poc.md](./run-review-poc.md)
- Policy YAML — [configure-project-policy.md](./configure-project-policy.md)
- Env и опциональные переменные — [environment.md](../03-reference/environment.md)
- Деплой — [deployment.md](../05-operations/deployment.md)
