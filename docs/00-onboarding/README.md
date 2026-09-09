# Быстрый старт

**Mira Review Bot** — автономный сервис AI-код-ревью для Merge Request в self-hosted GitLab: читает diff MR, подтягивает контекст задачи из Kaiten и прогоняет ревью через Cursor (`cursor-agent` / Composer 2.5). Подробнее о продукте — [Обзор](../01-concepts/overview.md).

---

## Предварительные требования

| Компонент | Версия / примечание |
| --- | --- |
| **Node.js** | **≥ 24** (`engines` в `package.json`; `.ts` запускается нативно, без ts-node) |
| **Cursor CLI** | `cursor-agent` в `PATH`; модель `composer-2.5` должна быть доступна |
| **git** | Нужен для checkout репозитория при ревью |
| **Токены доступа** | Cursor API, GitLab (read), Kaiten (**только read**) |

Установка Cursor CLI — официальный скрипт с [cursor.com](https://cursor.com). Проверка:

```bash
cursor-agent --list-models
```

---

## Клонирование и установка

```bash
git clone https://gitlab.ai-referent.ru/devops/ai-agents/mira-review-bot.git
cd mira-review-bot
npm install
```

---

## Настройка окружения

1. Скопируйте шаблон:

```bash
cp .env.example .env
```

2. Заполните **обязательные** переменные в `.env` (файл подхватывается при старте; при пропуске сервис упадёт с `ConfigError`). Ключ Cursor можно потом сменить без рестарта: `PUT /admin/secrets` — [environment.md](../03-reference/environment.md).

| Переменная | Назначение |
| --- | --- |
| `CURSOR_API_KEY` | API-ключ Cursor с доступом к `composer-2.5` |
| `GITLAB_BASE_URL` | Базовый URL self-hosted GitLab (например `https://gitlab.example.com`) |
| `GITLAB_TOKEN` | Токен для **чтения** MR и метаданных |
| `KAITEN_BASE_URL` | URL пространства Kaiten |
| `KAITEN_TOKEN` | Токен для **чтения** карточек (описание, критерии приёмки) |

> **Kaiten — строго read-only.** Личный токен не используйте для записи (комментарии, статусы, чек-листы). Для обратной связи в Kaiten позже нужен отдельный сервис-аккаунт.

Полная таблица env (обязательные и опциональные: `ROLE`, `MIRA_POLICY_CONFIG`, `CURSOR_AGENT_BIN` и др.) — [Справочник переменных окружения](../03-reference/environment.md).

---

## Команды разработки

Из `package.json`:

```bash
npm run typecheck   # tsc --noEmit (src + test)
npm run lint        # oxlint
npm test            # node --test
npm run build       # tsc → dist/
npm start           # node dist/entrypoints/main.js (после build)
npm run start:ts    # node src/entrypoints/main.ts (без сборки)
npm run dev         # node --watch src/entrypoints/cli/index.ts
```

Рекомендуемый минимум перед коммитом: `typecheck` + `lint` + `test`.

`npm start` / `npm run start:ts` — основной сервис (poller + worker, MVP). Для интерактивной разработки CLI удобен `npm run dev`.

---

## Первый запуск: PoC-ревью одного MR

Самый быстрый способ проверить связку GitLab → Kaiten → Cursor — ручная команда Phase 0:

```bash
node src/entrypoints/cli/index.ts poc --project <id> --mr <iid>
```

- `--project` — числовой id или путь `group/sub/project`
- `--mr` — IID merge request (положительное целое)

Полезные флаги:

- `--no-engine` — собрать контекст без вызова агента (отладка без расхода Cursor)
- `--cursor-bin <path>` — явный путь к `cursor-agent` (см. заметку про Windows ниже)
- `--keep` — не удалять checkout после прогона

Пошаговый сценарий, примеры и troubleshooting — [Запуск PoC-ревью](../02-guides/run-review-poc.md).

> На текущей фазе publisher работает в **dry-run**: находки пишутся в лог, **не** публикуются в GitLab/Kaiten.

---

## Windows: `cursor-agent`

Корневая обёртка `cursor-agent.cmd` / `.ps1` может быть сломана (ошибка «No version directories»). Используйте versioned `.cmd`, например:

```text
%LOCALAPPDATA%\cursor-agent\versions\<version>\cursor-agent.cmd
```

Либо задайте переменную окружения `CURSOR_AGENT_BIN` (читается в `src/entrypoints/main.ts`) или флаг `--cursor-bin` в PoC CLI.

---

## Куда смотреть дальше

| Тема | Куда |
| --- | --- |
| Термины, домен, как устроен продукт | [Концепции](../01-concepts/README.md) · [Обзор](../01-concepts/overview.md) |
| How-to: PoC, локальная разработка | [Гайды](../02-guides/README.md) · [PoC-ревью](../02-guides/run-review-poc.md) · [Локальная разработка](../02-guides/local-development.md) |
| Env, CLI, схемы, конфиги | [Справочник](../03-reference/README.md) · [Переменные окружения](../03-reference/environment.md) · [CLI](../03-reference/cli.md) |
| Hexagonal, слои, data flow | [Архитектура](../04-architecture/README.md) · [Обзор архитектуры](../04-architecture/overview.md) |
| Деплой, эксплуатация, prod | [Операции](../05-operations/README.md) · [Развёртывание](../05-operations/deployment.md) |
| Правила для AI-агентов | [AGENTS.md](../../AGENTS.md) |
| Статус задач и фазы | [tasks/](../../tasks/README.md) |
