# Codebase Map

Где что лежит. Нейминг: kebab-case файлы, каждая папка-модуль имеет `index.ts`
(barrel). ESM, относительные импорты **с расширением `.ts`**.

## Дерево (фактическое)

```text
mira-review-bot/
  src/
    config/                    # типизированный конфиг из ENV + policy-config (YAML)
      index.ts                 #   loadConfig() — обязательные ENV, ранний fail
      policy-config.ts         #   parse/loadPolicyConfigFile, PolicyConfigError
    core/                      # ЯДРО: не знает про внешние системы
      domain/index.ts          #   доменные типы (ReviewJob, Finding, ReviewResult, ...)
      ports/index.ts           #   ВСЕ интерфейсы-порты (контракты адаптеров)
      orchestrator/            #   createReviewPipeline (pipeline.ts) + runWorker (worker.ts)
      context/                 #   ContextBuilder, workspace, checkout (+ mirror-checkout: опц. кэш)
      partition/               #   Partitioner (partition.ts) + glob-фильтры
      aggregate/               #   Aggregator — слияние результатов юнитов
      normalize/               #   normalizeFindings (фильтры/пороги/дедуп/cap)
      idempotency/             #   findingFingerprint (канон), ключи идемпотентности
      linking/                 #   резолвер MR ↔ карточка Kaiten (id-extract, resolve)
      findings/                #   validateFindings — JSON-схема находок (ajv)
      policy/                  #   ProjectPolicy: types, defaults, merge, resolvePolicy
    adapters/                  # реализации портов под конкретные системы
      vcs/gitlab/              #   GitLabReader (read + listOpenMergeRequests), client, reader
      tracker/kaiten/          #   KaitenTracker (read-only), endpoints, http
      engine/cli/              #   CliHeadlessEngine (cursor-agent -p), spawn
      store/sqlite/            #   SqliteStateStore (node:sqlite), schema, fingerprint
      store/postgres/          #   PostgresStateStore (опц., pg) — масштаб multi-worker
      queue/inproc/            #   InProcQueue (дедуп по JobKey)
      queue/redis/             #   RedisQueue (опц., ioredis) — общая очередь на N worker'ов
      cache/                   #   TtlCache + CachingTaskTracker (опц. TTL-кэш чтения)
      publisher/log/           #   LogPublisher (dry-run: только структурный лог)
    entrypoints/
      main.ts                  #   composition root — ROLE → wire core+adapters
      poller/                  #   runPoller (discovery открытых MR → enqueue)
      cli/                     #   poc.ts + index.ts — ручной прогон ревью (PoC/отладка)
    observability/             #   logger (JSON + redact секретов/diff), metrics, redact
  prompts/                     # review.v1.md — версионируемый шаблон промпта
  deploy/                      # Dockerfile, docker-compose.yml, entrypoint.sh, config.example.yml
  docs/                        # нумерованная дока 00..13 (+ _ai/ memory bank)
  tasks/                       # план реализации по фазам + execution-order.md (статус)
  dist/                        # вывод tsc (артефакт сборки, не править)
```

## Как найти типичный модуль

| Ищу… | Где |
| --- | --- |
| Доменный тип / структуру находки | `src/core/domain/index.ts` |
| Интерфейс порта | `src/core/ports/index.ts` |
| Как связываются зависимости | `src/entrypoints/main.ts` (composition root) |
| Логику пайплайна ревью | `src/core/orchestrator/pipeline.ts` |
| Интеграцию с GitLab/Kaiten/Cursor | `src/adapters/{vcs/gitlab,tracker/kaiten,engine/cli}` |
| ENV / конфиг / политику | `src/config/`, `src/core/policy/` |
| Идемпотентность / фингерпринты | `src/core/idempotency/`, `src/adapters/store/sqlite/` |
| Тесты модуля | `src/<module>/*.test.ts` рядом с кодом; фейки — `src/core/ports/fakes.ts` |
| Промпт ревью | `prompts/review.v1.md` |

## Правила размещения нового кода

- Бизнес-логика ревью → `core/*` (+ порт в `core/ports`, если нужен новый внешний
  доступ). Интеграция с внешней системой → новый адаптер в `adapters/*`.
- Unit-тест → `*.test.ts` **рядом с модулем** (не отдельная папка `test/`).
- Связывание/инициализация — только в `entrypoints/`, не размазывать по коду.
- Дока репозитория — нумерованные `docs/NN-*.md`; ephemeral-статус — в
  `tasks/` / Kaiten / MR, **не** в memory bank.
