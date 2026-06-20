# Фаза 1 — MVP (автономный, polling, dry-run)

**Цель фазы:** превратить PoC в постоянно работающий сервис на сервере: сам находит
новые MR (polling), ревьюит через CLI-движок, складывает результат в лог и/или
комментарий Kaiten. В MR пока **не пишет** (dry-run).
**Критерий выхода фазы:** стабильно крутится на сервере, не дублирует ревью на одном
SHA, метрики идут, вывод осмысленный.

Связанные документы: [02-architecture](../docs/04-architecture/overview.md),
[04-triggers](../docs/04-architecture/triggers.md), [05-review-pipeline](../docs/04-architecture/review-pipeline.md),
[08-deployment](../docs/05-operations/deployment.md), [12-work-decomposition](../docs/04-architecture/decomposition-context-budget.md).

---

### T1.1 — Доменные типы и порты
- **Статус:** DONE
- **Размер:** M
- **Цель:** ядро, не зависящее от GitLab/Kaiten/Cursor.
- **Зависит от:** T0.* (PoC-наработки).
- **Артефакты:** `core/domain/*` (ReviewJob, ReviewContext, ReviewUnit, Finding,
  ReviewResult), `core/ports/*` (VcsReader, VcsWriter, TaskTracker, ReviewEngine,
  Queue, StateStore, Clock).
- **Шаги:**
  - [x] Определить доменные модели (см. [02](../docs/03-reference/domain-types.md) §4): добавлены
        `JobKey` (идентичность MR/SHA) и `TriggerKind`; `ReviewJob` = `JobKey` +
        `trigger` + `enqueuedAt`; `ReviewContext.job` ссылается на `JobKey`.
  - [x] Описать интерфейсы портов (только сигнатуры, без реализаций): добавлены
        `Queue` (enqueue/dequeue/size, дедуп по `JobKey`), `StateStore`
        (`seen`/`record` по `ReviewKey` с prompt/partition-версиями), `Clock`.
  - [x] Правило зависимостей: core ← adapters ← entrypoints ([13](../docs/04-architecture/adr/001-hexagonal-architecture.md) §2).
- **DoD:** core компилируется без зависимостей на адаптеры; есть fake-реализации портов
  для тестов (`test/fakes.ts`: in-memory Queue/StateStore + Fake Reader/Writer/Tracker/
  Engine/Clock; контрактные тесты в `test/ports.test.ts`). Typecheck/lint/format/61 тестов зелёные.
- **Ссылки:** [02](../docs/03-reference/domain-types.md), [13](../docs/04-architecture/adr/001-hexagonal-architecture.md).

### T1.2 — Конфиг и политика (+ discovery: explicit)
- **Статус:** DONE
- **Размер:** M
- **Цель:** типизированная конфигурация и слияние политик.
- **Зависит от:** T1.1.
- **Артефакты:** `core/policy/*` (types/defaults/merge), `config/policy-config.ts`
  (`parsePolicyConfig`/`loadPolicyConfigFile`, `PolicyConfigError`); `config/index.ts`
  (существующие `MiraConfig`/`loadConfig` не тронуты).
- **Шаги:**
  - [x] Схема конфига ([08](../docs/03-reference/policy-config.md) §4.1) + валидация (YAML → типы, ранний fail).
  - [x] Слияние `defaults` ← `projects.<path>` (`resolvePolicy`; per-repo `.mira/config.yml` — позже).
  - [x] `discovery.mode: explicit` — список пилотных репозиториев.
  - [x] Поля: `review_on`, `strictness`, `ignored_globs`, `context_budget`, `decomposition`, `model`.
- **DoD:** неверный конфиг → ранний fail с понятной ошибкой; политика для проекта вычисляется. ✅ 3 теста.
- **Ссылки:** [08](../docs/03-reference/policy-config.md) §4.

### T1.3 — State store (SQLite) и идемпотентность
- **Статус:** DONE
- **Размер:** M
- **Цель:** хранить обработанные `(MR, SHA)`, находки, метрики; гарантировать идемпотентность запуска.
- **Зависит от:** T1.1.
- **Артефакты:** `adapters/store/sqlite/*` (schema/migrate, fingerprint, `SqliteStateStore`)
  на встроенном `node:sqlite`; схема `MR_REVIEW` + `FINDING_RECORD`.
- **Шаги:**
  - [x] Реализовать `StateStore` порт на SQLite (миграции при открытии).
  - [x] `seen(project, mr, sha, prompt_version, partition_version)` (PK по полному `ReviewKey`).
  - [x] Запись результата ревью и SHA-256 фингерпринтов находок (идемпотентный upsert).
- **DoD:** повторный запуск на том же SHA определяется как «уже сделано». ✅ 3 теста (`:memory:`).
- **Ссылки:** [05](../docs/04-architecture/review-pipeline.md) §6, §8.

### T1.4 — In-process очередь и воркер-цикл
- **Статус:** DONE
- **Размер:** M
- **Цель:** буфер задач + последовательная/ограниченно-параллельная обработка.
- **Зависит от:** T1.1.
- **Артефакты:** `adapters/queue/inproc` (`InProcQueue` + блокирующий `take`/`close`),
  `core/orchestrator/worker.ts` (`runWorker` + минимальный `JobSource`). _Entrypoint
  `worker` (composition root) — позже при сборке пайплайна._
- **Шаги:**
  - [x] Очередь с дедупом по ключу `(project, mr, sha)` (`JobKey`).
  - [x] Воркер: брать job → запуск инъектируемого handler'а (пайплайн подключается позже).
  - [x] Ограничение конкурентности `MAX_CONCURRENCY` (N taker-циклов; ошибка handler'а не валит цикл).
- **DoD:** задачи обрабатываются по очереди, дубликаты схлопываются, лимит работает. ✅ 11 тестов.
- **Ссылки:** [02](../docs/04-architecture/review-pipeline.md) §2.2–§2.3.

### T1.5 — Poller (триггер по первичному состоянию)
- **Статус:** DONE
- **Размер:** M
- **Цель:** обнаруживать MR, требующие ревью, без вебхуков.
- **Зависит от:** T0.3, T1.2, T1.4.
- **Артефакты:** новый порт `VcsMrLister`/`MrSummary` (additive в `core/ports`),
  GitLab `listOpenMergeRequests`, `entrypoints/poller` (`selectJobs`/`pollOnce`/`runPoller`).
- **Шаги:**
  - [x] Периодический опрос открытых MR в пилотных проектах (`GET …/merge_requests?state=opened`, пагинация).
  - [x] Применять `review_on`: ready (не-draft) → задача; draft пропускается; `push`/`reopen` выкл. по дефолту;
        дедуп через инъектируемый `alreadyHandled` (фиксы после ревью не триггерят).
  - [x] Ставить `ReviewJob` в очередь (`InProcQueue.enqueue`).
- **DoD:** новый MR/переход в ready → задача; фиксы после ревью не триггерят. ✅ 7 тестов.
- **Ссылки:** [04](../docs/04-architecture/triggers.md) (Вариант B, правила `review_on`).

### T1.6 — Context Builder + эфемерный воркспейс
- **Статус:** DONE
- **Размер:** M
- **Цель:** воспроизводимый изолированный checkout + пакет контекста для агента.
- **Зависит от:** T0.3–T0.5.
- **Артефакты:** `core/context/context-builder.ts` (`ContextBuilder.build`),
  `core/context/workspace.ts` (имена воркспейсов + `gcWorkspaces` по TTL), `core/context/index.ts`.
- **Шаги:**
  - [x] Partial clone + checkout (переиспользует `prepareCheckout`/`buildCloneUrl`, инъектируемо).
  - [x] Сборка `ReviewContext` (метаданные, diff, карточка через `resolveCard`, мягкая деградация).
  - [x] Материализация `.mira/context.json` (через инъектируемый fs; `prompt.md` рендерит движок).
  - [x] Очистка воркспейса (`cleanup()`) + GC по TTL (`gcWorkspaces`).
- **DoD:** агент получает чистый checkout и контекст; воркспейс удаляется. ✅ 4 теста (на фейках).
- **Ссылки:** [05](../docs/04-architecture/review-pipeline.md) §2–§3.

### T1.7 — ReviewEngine порт + CliHeadlessEngine
- **Статус:** DONE
- **Размер:** M
- **Цель:** запуск Cursor через CLI за единым интерфейсом.
- **Зависит от:** T0.2, T0.6, T1.1.
- **Артефакты:** `adapters/engine/cli` (база — из PoC; добавлены `timeoutMs` + retry, `spawn` с `AbortSignal`).
- **Шаги:**
  - [x] Запуск `cursor-agent -p --output-format json --model composer-2.5 --force --trust` (cwd = checkout).
  - [x] Передача промпта (stdin); чтение/парсинг `findings.json`/fenced JSON; валидация схемой.
  - [x] Таймаут (abort дочернего процесса), обработка ненулевого кода возврата, 1 retry при невалидном JSON/схеме.
- **DoD:** для юнита возвращается валидный `ReviewResult` либо понятная деградация. ✅ 14 тестов.
- **Ссылки:** [03](../docs/04-architecture/adr/004-review-engine-port-cli-then-sdk.md) (A), [07](../docs/03-reference/finding-schema.md) §3.

### T1.8 — Декомпозиция (упрощённая)
- **Статус:** DONE
- **Размер:** M
- **Цель:** не упереться в контекст на больших MR.
- **Зависит от:** T1.6.
- **Артефакты:** `core/partition` (`partitionReview`, glob-матчер, режим `single`), `core/aggregate` (`aggregateResults`).
- **Шаги:**
  - [x] Один task-scope на MR; отсечь `ignored_globs`/бинари.
  - [x] Чанкинг по `context_budget` (режим `estimate: bytes`), упаковка по байт-бюджету.
  - [x] Не резать hunk (границы по `diff --git`); стабильный порядок (сортировка путей); оверсайз-файл → отдельный чанк.
  - [x] Агрегация находок нескольких чанков (дедуп `category|filePath|message`, худший вердикт/статус критерия).
- **DoD:** большой MR корректно делится на чанки; находки сводятся без дублей. ✅ 15 тестов.
- **Ссылки:** [12](../docs/04-architecture/decomposition-context-budget.md) §3–§4.

### T1.9 — Нормализация находок (фильтры/пороги/дедуп)
- **Статус:** DONE
- **Размер:** S
- **Цель:** убрать шум, применить строгость, посчитать фингерпринты.
- **Зависит от:** T1.7, T1.8.
- **Артефакты:** `core/idempotency/fingerprint.ts` (канон; sqlite-адаптер делегирует туда),
  `core/normalize/normalize.ts` (`normalizeFindings`).
- **Шаги:**
  - [x] Фильтр по `ignored_globs` (через glob-матчер из `core/partition`).
  - [x] Пороги `strictness`: strict=все, balanced=без `nit`, lenient=только blocker/major.
  - [x] Фингерпринт находки по содержимому/якорю (SHA-256 `category|filePath|message`, не по номеру строки).
  - [x] Кап на количество (top-N по severity, дефолт 50) + детерминированная сортировка; счётчики `dropped`.
- **DoD:** одинаковые находки имеют стабильный fingerprint; шум отфильтрован. ✅ 14 тестов.
- **Ссылки:** [05](../docs/04-architecture/review-pipeline.md) §5–§6.

### T1.10 — Dry-run Publisher (лог + Kaiten)
- **Статус:** DONE
- **Размер:** S
- **Цель:** вывести результат, не трогая MR.
- **Зависит от:** T0.4, T1.9.
- **Артефакты:** порт `Publisher` (`core/ports`), `adapters/publisher/log` (`LogPublisher`).
- **Шаги:**
  - [x] Структурный вывод сводки + находок (+ критериев/деградаций) в лог с корреляц. полями и `dry_run`.
  - [~] Комментарий-сводка в Kaiten — **не реализуем под личным токеном** (Kaiten read-only,
        см. `.cursor/rules`); запись-фидбэк отложена до bot-аккаунта (фаза 3+).
  - [x] Без записи в GitLab (это Фаза 2).
- **DoD:** по итогам ревью видна сводка в логе; MR/карточка не изменяются. ✅ 4 теста.
- **Ссылки:** [06](../docs/03-reference/integrations-api.md) §4, [11](../docs/01-concepts/roadmap.md) (Фаза 1).

### T1.11 — Логи и базовые метрики
- **Статус:** DONE
- **Размер:** S
- **Цель:** наблюдаемость с первого дня.
- **Зависит от:** T1.4.
- **Артефакты:** `observability/` (`createLogger`, `createMetricRegistry`, `redact`).
- **Шаги:**
  - [x] JSON-логи (одна строка на вызов) с мержем корреляц. полей `review_id`/`run_id` через `child()`.
  - [x] Метрики: `reviews_total`, `review_duration_seconds`, `engine_errors_total`,
        `review_units_total`, `tokens_used_total` (counters/histograms + `snapshot()`).
  - [x] Маскирование секретов/токенов и diff/prompt (по длине); паттерн `oauth2:***@`.
- **DoD:** видно поток ревью, латентность и ошибки; секреты не утекают в логи. ✅ 5 тестов.
- **Ссылки:** [10](../docs/05-operations/observability.md).

### T1.12 — Контейнеризация и запуск на сервере
- **Статус:** DONE (код/образ готовы; деплой на сервер ждёт 🔑P2/ops)
- **Размер:** M
- **Цель:** «всё-в-одном» образ, работающий на выделенном сервере.
- **Зависит от:** T1.1–T1.11.
- **Артефакты:** `core/orchestrator/pipeline.ts` (`createReviewPipeline`), `entrypoints/main.ts`
  (composition root по `ROLE`), `deploy/Dockerfile`, `deploy/docker-compose.yml`,
  `deploy/entrypoint.sh`, `deploy/config.example.yml`, `.dockerignore`.
- **Шаги:**
  - [x] Dockerfile на `node:24-bookworm-slim` + Cursor CLI + git ([08](../docs/05-operations/deployment.md) §2).
  - [x] MVP-режим: один контейнер `api+poller+worker` (`ROLE=all`), SQLite, in-proc очередь.
  - [x] Секреты через ENV; `/healthz` + healthcheck в compose; graceful shutdown (SIGINT/SIGTERM).
  - [~] Развернуть на сервере — **ждёт ops/🔑P2** (доступных пилотных репозиториев у бота пока нет).
- **DoD:** сервис собирается и поднимается (smoke `/healthz` ok на src и dist); пайплайн собран и
  юнит-протестирован (идемпотентность, нормализация, деградация). Живой прогон на реальных MR — после 🔑P2.
- **Ссылки:** [08](../docs/05-operations/deployment.md) §2–§3, §6, §8.

---

## Итог фазы 1
Автономный сервис на сервере: сам находит MR, ревьюит через Composer 2.5, выдаёт
идемпотентный результат в лог/Kaiten. Готовность включать публикацию в MR (Фаза 2).
