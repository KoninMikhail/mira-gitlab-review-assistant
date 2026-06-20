# Фаза 3 — Качество и устойчивость

**Цель фазы:** перейти на SDK-движок, сделать сервис устойчивым под нагрузкой
(очередь/воркеры/повторы), включить полную декомпозицию по задачам и наладить
обратную связь по качеству находок.
**Критерий выхода фазы:** управляемый false-positive rate, целевая латентность под
нагрузкой, корректная работа на больших/multi-task MR.

Связанные документы: [03-implementation-options](../docs/04-architecture/adr/004-review-engine-port-cli-then-sdk.md),
[10-observability](../docs/05-operations/observability.md), [12-work-decomposition](../docs/04-architecture/decomposition-context-budget.md).

---

### T3.1 — SdkLocalEngine (переключение дефолта)
- **Статус:** TODO
- **Размер:** L
- **Цель:** заменить CLI-движок на `@cursor/sdk` (local runtime) за тем же портом.
- **Зависит от:** T1.7.
- **Артефакты:** `adapters/engine/sdk`.
- **Шаги:**
  - [ ] `Agent.create({ model: { id: "composer-2.5" }, local: { cwd, settingSources: [] }, apiKey })`.
  - [ ] Передача MCP inline (Kaiten read; GitLab read) при необходимости.
  - [ ] Стриминг (`run.stream()`) → прогресс; `await run.wait()` → результат.
  - [ ] `await using`/dispose; логировать `run.id`/`agent.agentId` сразу после `send`.
  - [ ] Конфиг-флаг выбора движка (cli|sdk); дефолт → sdk.
- **DoD:** ревью идёт через SDK; ресурсы освобождаются; поведение эквивалентно/лучше CLI.
- **Ссылки:** [03](../docs/04-architecture/adr/004-review-engine-port-cli-then-sdk.md) (B).

### T3.2 — Различение ошибок, повторы, dead-letter
- **Статус:** TODO
- **Размер:** M
- **Цель:** корректно реагировать на разные классы сбоев.
- **Зависит от:** T3.1, T1.4.
- **Шаги:**
  - [ ] `CursorAgentError` (не стартовал: auth/config/сеть) → не ретраить вслепую, алерт.
  - [ ] `result.status == "error"` (стартовал и упал) → инспекция, dead-letter.
  - [ ] Retry с backoff для транзиентных (учитывать `isRetryable`/`retry_after`).
  - [ ] Dead-letter очередь + алерт.
- **DoD:** транзиентные ошибки автоматически повторяются; фатальные уходят в dead-letter с алертом.
- **Ссылки:** [05](../docs/04-architecture/review-pipeline.md) §9, [03](../docs/04-architecture/adr/004-review-engine-port-cli-then-sdk.md) (ловушка №2).

### T3.3 — Redis-очередь и несколько воркеров
- **Статус:** TODO
- **Размер:** M
- **Цель:** горизонтальное масштабирование и устойчивость.
- **Зависит от:** T1.4.
- **Артефакты:** `adapters/queue/redis`, обновлённый docker-compose.
- **Шаги:**
  - [ ] Реализовать `Queue` порт на Redis (надёжная доставка, видимость, повторы).
  - [ ] Разнести процессы: `api` + N×`worker`; общий store/queue.
  - [ ] Лимиты конкурентности глобально и `max_parallel_units_per_mr`.
- **DoD:** несколько воркеров обрабатывают очередь параллельно; перезапуск без потери задач.
- **Ссылки:** [02](../docs/04-architecture/overview.md) §6, [08](../docs/05-operations/deployment.md) §3, §6.

### T3.4 — Полная декомпозиция (по задачам + агрегация + synthesis)
- **Статус:** TODO
- **Размер:** L
- **Цель:** качественно ревьюить большие и multi-task MR.
- **Зависит от:** T1.8.
- **Артефакты:** `core/partition` (commit-map), `core/aggregate` (полный), synthesis-проход.
- **Шаги:**
  - [ ] Группировка по задачам: `single` → `commit-map` (коммит→карточка) / `heuristic`.
  - [ ] Параллельный прогон юнитов на слотах; общий read-only checkout.
  - [ ] Агрегатор: дедуп находок, сводный `requirements_coverage`, худший вердикт.
  - [ ] Опциональный synthesis-проход по сводкам для кросс-юнитных рисков.
  - [ ] `partition_version`; детерминированность разбиения (стабильные fingerprints).
- **DoD:** multi-task MR ревьюится по задачам; результаты корректно сводятся; нет дублей.
- **Ссылки:** [12](../docs/04-architecture/decomposition-context-budget.md) §2, §4–§6.

### T3.5 — Membership discovery + per-repo конфиг + hybrid
- **Статус:** TODO
- **Размер:** M
- **Цель:** масштабировать подключение проектов без ручного списка.
- **Зависит от:** T1.2; bot-аккаунт в группе.
- **Шаги:**
  - [ ] `discovery.mode: membership` — список проектов по членству бота (`list_projects`).
  - [ ] Фильтры discovery (archived, globs, min_access_level).
  - [ ] Подхват `.mira/config.yml` из дефолтной ветки репозитория (per-repo override).
  - [ ] Опция `hybrid` (`require_topic`/`require_repo_optin`).
  - [ ] Глобальные «потолки» лимитов, которые per-repo не превышает.
- **DoD:** добавление бота в проект/группу автоматически включает ревью; per-repo настройки применяются.
- **Ссылки:** [08](../docs/03-reference/policy-config.md) §4.2–§4.3.

### T3.6 — Цикл качества (метрики принятия, тюнинг)
- **Статус:** TODO
- **Размер:** M
- **Цель:** снижать false positives и повышать полезность.
- **Зависит от:** T2.3, T1.11.
- **Шаги:**
  - [ ] Отслеживать accepted/dismissed (реакции людей, резолвы, `@mira ignore`).
  - [ ] Метрики: `findings_accepted/dismissed`, `false_positive_rate`, `requirements_coverage`.
  - [ ] Версионировать промпт (`prompt_version`); A/B по версиям.
  - [ ] Итеративно подстраивать пороги строгости и промпт.
- **DoD:** есть измеримый FP-rate и тренд его снижения; изменения промпта отслеживаются.
- **Ссылки:** [10](../docs/05-operations/observability.md) §3.2, [07](../docs/03-reference/finding-schema.md) §7.

### T3.7 — Postgres, дашборды, алертинг
- **Статус:** TODO
- **Размер:** M
- **Цель:** прод-наблюдаемость и хранилище под нагрузку.
- **Зависит от:** T1.3, T1.11, T3.3.
- **Шаги:**
  - [ ] Миграция state store на Postgres; бэкапы.
  - [ ] Дашборды: поток, здоровье, стоимость, полезность ([10](../docs/05-operations/observability.md) §7).
  - [ ] Алерты: рост startup-ошибок, dead-letter, queue wait, дубликаты, диск ([10](../docs/05-operations/observability.md) §6).
- **DoD:** есть рабочие дашборды и алерты; БД масштабируется и бэкапится.
- **Ссылки:** [10](../docs/05-operations/observability.md), [08](../docs/05-operations/deployment.md) §6–§7.

---

## Итог фазы 3
Прод-готовый сервис: SDK-движок, устойчивая обработка, полная декомпозиция по
задачам, измеримое качество и наблюдаемость. Готовность к опциональным расширениям
(Фаза 4).
