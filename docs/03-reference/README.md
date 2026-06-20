# 03 — Справочник (reference)

Факты из кода: env, порты, домен, схемы, policy, CLI, внешние API. Минимум prose.

## Файлы раздела

| Файл | Содержание |
| --- | --- |
| [environment.md](./environment.md) | Переменные окружения (обязательные / опциональные) |
| [ports.md](./ports.md) | Порты `core` и реализации в `adapters` |
| [domain-types.md](./domain-types.md) | Доменные типы `src/core/domain` |
| [finding-schema.md](./finding-schema.md) | JSON-контракт findings (snake_case) и маппинг в домен |
| [policy-config.md](./policy-config.md) | YAML policy (`MIRA_POLICY_CONFIG`) |
| [cli.md](./cli.md) | Entrypoints: `ROLE`, `main`, CLI `poc`, флаги `cursor-agent` |
| [integrations-api.md](./integrations-api.md) | GitLab REST, Kaiten REST (read-only), Cursor CLI |

## Связанные разделы

| Тема | Путь |
| --- | --- |
| Обзор продукта | [../01-concepts/overview.md](../01-concepts/overview.md) |
| Глоссарий домена | [../01-concepts/domain-glossary.md](../01-concepts/domain-glossary.md) |
| Настройка policy | [../02-guides/configure-project-policy.md](../02-guides/configure-project-policy.md) |
| PoC одного MR | [../02-guides/run-review-poc.md](../02-guides/run-review-poc.md) |
| Архитектура | [../04-architecture/overview.md](../04-architecture/overview.md) |
| Пайплайн ревью | [../04-architecture/review-pipeline.md](../04-architecture/review-pipeline.md) |
| ADR | [../04-architecture/adr/README.md](../04-architecture/adr/README.md) |
| Безопасность | [../05-operations/security.md](../05-operations/security.md) |
| Наблюдаемость | [../05-operations/observability.md](../05-operations/observability.md) |

## Исходники

| Область | Путь в репо |
| --- | --- |
| Env / policy loader | `src/config/` |
| Порты | `src/core/ports/index.ts` |
| Домен | `src/core/domain/index.ts` |
| Findings | `src/core/findings/`, `schema/findings.schema.json` |
| Policy | `src/core/policy/` |
| Composition root | `src/entrypoints/main.ts` |
| Адаптеры | `src/adapters/` |
