# AGENTS.md

Точка входа для AI-агентов в репозитории **Mira Review Bot** (AI код-ревью для
GitLab MR на базе Cursor).

## Перед задачей — прочитать Memory Bank

Источник сжатого контекста: [`docs/_ai/`](docs/_ai/README.md). Порядок чтения и
карта на полную документацию — в [`docs/_ai/README.md`](docs/_ai/README.md).
Полная дока — [`docs/`](docs/README.md). Статус задач — [`tasks/`](tasks/README.md).

## Команды (см. `tech-stack.md`)

```bash
npm run typecheck   # tsc --noEmit (src + test)
npm run lint        # oxlint
npm test            # node --test
npm run build       # tsc → dist/
```

Перед коммитом — минимум `typecheck` + `lint` + `test`.

## Критичные правила

- **Kaiten — строго read-only** под текущим личным токеном. Любая запись
  запрещена (см. `.cursor/rules/kaiten-read-only.mdc` и
  [`docs/_ai/integrations.md`](docs/_ai/integrations.md)).
- **Гексагон:** `core` не зависит от внешних систем; интеграции — в `adapters/*`
  за портами; связывание — только в `entrypoints/main.ts`.
- TypeScript ESM, Node ≥24, относительные импорты с расширением `.ts`.
- Conventional Commits; коммитить логически завершённые рабочие куски
  (`.cursor/rules/auto-commit.mdc`).
