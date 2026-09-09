# Architecture Decision Records (ADR)

Repo-level архитектурные решения Mira Review Bot. Каждая запись фиксирует **контекст,
принятое решение и последствия** — обоснование из ранних design-доков, сохранённое
при реорганизации `docs/` в стандарт `.cursor/rules/docs-structure.mdc`.

Родительский раздел: [../README.md](../README.md). См. также [../overview.md](../overview.md).

| # | Заголовок | Статус | Файл |
| --- | --- | --- | --- |
| 001 | Гексагональная архитектура (порты и адаптеры) | Принято | [001-hexagonal-architecture.md](./001-hexagonal-architecture.md) |
| 002 | TypeScript и `@cursor/sdk` вместо Python | Принято | [002-typescript-cursor-sdk.md](./002-typescript-cursor-sdk.md) |
| 003 | Модульный монолит и процессы-роли | Принято | [003-modular-monolith-roles.md](./003-modular-monolith-roles.md) |
| 004 | Порт `ReviewEngine`: CLI → SDK → Cloud | Принято | [004-review-engine-port-cli-then-sdk.md](./004-review-engine-port-cli-then-sdk.md) |
| 005 | Фиксированная модель `composer-2.5` | Заменено | [005-fixed-model-composer-2-5.md](./005-fixed-model-composer-2-5.md) |
| 006 | MVP-триггер: polling по первичному состоянию MR | Принято | [006-polling-trigger-mvp.md](./006-polling-trigger-mvp.md) |
| 007 | SQLite как state store MVP | Принято | [007-sqlite-state-store.md](./007-sqlite-state-store.md) |
| 008 | Kaiten строго read-only (личный токен) | Принято | [008-kaiten-read-only.md](./008-kaiten-read-only.md) |
| 009 | Dry-run publisher на фазе MVP | Принято | [009-dry-run-publisher.md](./009-dry-run-publisher.md) |
| 010 | Связка MR ↔ Kaiten (ветка + описание) | Принято | [010-mr-kaiten-linking.md](./010-mr-kaiten-linking.md) |
| 011 | Egress кода в Cursor API разрешён | Принято | [011-cursor-api-egress-allowed.md](./011-cursor-api-egress-allowed.md) |
| 012 | Не запускать через GitLab CI/CD pipelines | Принято | [012-no-gitlab-ci-pipelines.md](./012-no-gitlab-ci-pipelines.md) |
| 013 | Трёхслойная модель правил ревью (baseline + профиль + repo-local) | Принято | [013-layered-review-guidance.md](./013-layered-review-guidance.md) |
| 014 | Ждать обязательный CI перед ревью | Принято | [014-wait-required-ci-before-review.md](./014-wait-required-ci-before-review.md) |
| 015 | CI как доп. контекст ревью; повтор при смене исхода | Принято | [015-ci-as-review-context.md](./015-ci-as-review-context.md) |
| 016 | Approve бота — консультативный сигнал, не merge gate | Принято | [016-optional-mr-approve-signal.md](./016-optional-mr-approve-signal.md) |
| 017 | Conversational assistant — отдельный путь от ревью | Принято | [017-assistant-chat.md](./017-assistant-chat.md) |
| 018 | ChatOps-алиасы ревью и правка description MR | Принято | [018-chatops-aliases-and-mr-description.md](./018-chatops-aliases-and-mr-description.md) |
| 019 | Live-ротация токенов без рестарта | Принято | [019-live-secret-rotation.md](./019-live-secret-rotation.md) |
| 020 | Пул Cursor API-ключей с failover | Принято | [020-cursor-key-failover.md](./020-cursor-key-failover.md) |
| 021 | Фиксированная модель `cursor-grok-4.6[fast=true]` | Принято | [021-fixed-model-cursor-grok-4-6-fast.md](./021-fixed-model-cursor-grok-4-6-fast.md) |
