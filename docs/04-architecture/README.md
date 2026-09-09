# 04 — Архитектура

Раздел описывает **системный дизайн** Mira Review Bot: слои кода, потоки данных,
пайплайн ревью, триггеры и декомпозицию MR. Документы отражают **фактическую
реализацию фаз 0–1** (polling, CLI-движок, dry-run publisher) и явно помечают
запланированное на следующие фазы.

## С чего начать

1. [overview.md](./overview.md) — гексагональная архитектура, карта компонентов,
   правило зависимостей, процессы `ROLE`, соответствие каталогам `src/`.
2. [review-pipeline.md](./review-pipeline.md) — сквозной пайплайн одного
   `ReviewJob`: идемпотентность, деградация, публикация и state store.
3. [triggers.md](./triggers.md) — как Mira узнаёт о MR: polling (MVP),
   webhook и ChatOps (фаза 2+), почему нет GitLab CI/CD.
4. [decomposition-context-budget.md](./decomposition-context-budget.md) —
   разбиение MR на `ReviewUnit`, бюджет контекста, агрегация результатов.
5. [presence-and-ci-wait.md](./presence-and-ci-wait.md) — предревью-ack и
   реальное ожидание обязательного CI (ручные джобы игнор).

## Архитектурные решения (ADR)

Ключевые решения зафиксированы отдельными ADR в подкаталоге `adr/`:

| ADR | Тема |
| --- | --- |
| [adr/README.md](./adr/README.md) | Оглавление ADR |
| [001-hexagonal-architecture.md](./adr/001-hexagonal-architecture.md) | Гексагон (ports & adapters) |
| [002-typescript-cursor-sdk.md](./adr/002-typescript-cursor-sdk.md) | TypeScript и Cursor SDK |
| [003-modular-monolith-roles.md](./adr/003-modular-monolith-roles.md) | Модульный монолит и роли процессов |
| [004-review-engine-port-cli-then-sdk.md](./adr/004-review-engine-port-cli-then-sdk.md) | Порт движка: CLI → SDK |
| [005-fixed-model-composer-2-5.md](./adr/005-fixed-model-composer-2-5.md) | Фиксированная модель Composer 2.5 |
| [006-polling-trigger-mvp.md](./adr/006-polling-trigger-mvp.md) | Polling как триггер MVP |
| [007-sqlite-state-store.md](./adr/007-sqlite-state-store.md) | SQLite для состояния |
| [008-kaiten-read-only.md](./adr/008-kaiten-read-only.md) | Kaiten только read-only |
| [009-dry-run-publisher.md](./adr/009-dry-run-publisher.md) | LogPublisher (dry-run) |
| [010-mr-kaiten-linking.md](./adr/010-mr-kaiten-linking.md) | Связка MR ↔ карточка Kaiten |
| [011-cursor-api-egress-allowed.md](./adr/011-cursor-api-egress-allowed.md) | Egress к Cursor API |
| [012-no-gitlab-ci-pipelines.md](./adr/012-no-gitlab-ci-pipelines.md) | Без GitLab CI/CD pipelines |
| [013-layered-review-guidance.md](./adr/013-layered-review-guidance.md) | Трёхслойные правила ревью |
| [014-wait-required-ci-before-review.md](./adr/014-wait-required-ci-before-review.md) | Ожидание обязательного CI |
| [015-ci-as-review-context.md](./adr/015-ci-as-review-context.md) | CI как контекст ревью |

## Связанные разделы

| Тема | Где |
| --- | --- |
| Продукт и термины | [../01-concepts/overview.md](../01-concepts/overview.md), [../01-concepts/domain-glossary.md](../01-concepts/domain-glossary.md) |
| Дорожная карта | [../01-concepts/roadmap.md](../01-concepts/roadmap.md) |
| Контракты портов и типы | [../03-reference/ports.md](../03-reference/ports.md), [../03-reference/domain-types.md](../03-reference/domain-types.md) |
| Схема находок, политика | [../03-reference/finding-schema.md](../03-reference/finding-schema.md), [../03-reference/policy-config.md](../03-reference/policy-config.md) |
| PoC / локальный прогон | [../02-guides/run-review-poc.md](../02-guides/run-review-poc.md) |
| Деплой, наблюдаемость, ИБ | [../05-operations/deployment.md](../05-operations/deployment.md), [../05-operations/observability.md](../05-operations/observability.md), [../05-operations/security.md](../05-operations/security.md) |
