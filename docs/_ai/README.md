# Memory Bank — Mira Review Bot

Сжатый снимок проекта для AI-агента. Память сбрасывается между сессиями —
**читать перед каждой задачей**. Длинные гайды живут в [`docs/`](../README.md);
memory bank **ссылается**, а не дублирует.

## Обязательное чтение (порядок)

| # | Файл | Назначение |
| --- | --- | --- |
| 1 | [`README.md`](./README.md) | Эта карта |
| 2 | [`project-brief.md`](./project-brief.md) | Что за проект, границы, ключевые решения, статус |
| 3 | [`tech-stack.md`](./tech-stack.md) | Стек, команды (lint/test/build), ENV |
| 4 | [`architecture.md`](./architecture.md) | Гексагон, порты, пайплайн ревью |
| 5 | [`codebase-map.md`](./codebase-map.md) | Дерево репо, где что лежит, куда класть новое |

## Дополнительно (по релевантности)

| Файл | Когда читать |
| --- | --- |
| [`integrations.md`](./integrations.md) | Работа с GitLab / Kaiten / Cursor, доступы, **Kaiten read-only** |

## Карта на полную документацию

Полная дока реорганизована в нумерованные **директории-разделы** `docs/NN-*/`
(стандарт `docs-structure.mdc`). Оглавление — [`docs/README.md`](../README.md).

| Тема | Источник правды |
| --- | --- |
| Быстрый старт / env / первый запуск | [`docs/00-onboarding/`](../00-onboarding/README.md) |
| Обзор, цели, требования, глоссарий, roadmap | [`docs/01-concepts/`](../01-concepts/README.md) |
| How-to: PoC, policy, локальная разработка | [`docs/02-guides/`](../02-guides/README.md) |
| Reference: env, порты, домен, схема находок, policy, CLI, API | [`docs/03-reference/`](../03-reference/README.md) |
| Архитектура: гексагон, пайплайн, триггеры, декомпозиция | [`docs/04-architecture/`](../04-architecture/README.md) |
| **Решения (ADR)** | [`docs/04-architecture/adr/`](../04-architecture/adr/README.md) |
| Деплой / безопасность / наблюдаемость | [`docs/05-operations/`](../05-operations/README.md) |
| **Статус задач / прогресс** | [`tasks/execution-order.md`](../../tasks/execution-order.md) |

## Когда обновлять

Обновляй `docs/_ai/`, когда изменилась структура репо/стек или появился устойчивый
паттерн вне `architecture.md`. Текущий фокус и статус задач — **не здесь** (в
`tasks/`, Kaiten, MR, чате). По запросу «update memory bank» — пересмотреть все
файлы и синхронизировать с кодом (приоритет: `codebase-map.md`/`architecture.md`
→ `tech-stack.md` → остальное).
