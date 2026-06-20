# Запуск PoC-ревью одного MR

Ручной прогон Phase 0: одна команда собирает контекст MR (GitLab + Kaiten), при необходимости вызывает `cursor-agent` и печатает читаемую сводку находок в консоль. Publisher **не** публикует комментарии в GitLab — это dry-run фаза MVP.

Реализация: `src/entrypoints/cli/poc.ts`, точка входа CLI — `src/entrypoints/cli/index.ts`.

---

## Предварительные условия

1. **Node.js ≥ 24**, зависимости установлены (`npm install`).
2. **git** в `PATH` — для checkout ветки MR.
3. **Cursor CLI** (`cursor-agent`) с доступной моделью `composer-2.5` (проверка: `cursor-agent --list-models`).
4. Файл `.env` (шаблон — `.env.example`) с **обязательными** переменными — валидируются в `loadConfig()` (`src/config/index.ts`):

| Переменная | Назначение |
| --- | --- |
| `CURSOR_API_KEY` | API-ключ Cursor; передаётся агенту как `CURSOR_API_KEY` |
| `GITLAB_BASE_URL` | Базовый URL GitLab |
| `GITLAB_TOKEN` | Токен для чтения MR и clone |
| `KAITEN_BASE_URL` | URL Kaiten |
| `KAITEN_TOKEN` | Токен для **чтения** карточек (строго read-only) |

Полная таблица env — [Справочник переменных окружения](../03-reference/environment.md).

---

## Команда

```bash
node src/entrypoints/cli/index.ts poc --project <id> --mr <iid>
```

Альтернатива для итераций по CLI (watch на `src/entrypoints/cli/index.ts`):

```bash
npm run dev -- poc --project <id> --mr <iid>
```

Справка:

```bash
node src/entrypoints/cli/index.ts help
```

---

## Аргументы

### Обязательные

| Флаг | Описание |
| --- | --- |
| `--project <id>` | Числовой id проекта GitLab **или** путь `group/sub/project` |
| `--mr <iid>` | IID merge request — положительное целое число |

### Опциональные

| Флаг | Описание |
| --- | --- |
| `--workspace <dir>` | Директория checkout; по умолчанию — временная папка под `os.tmpdir()` |
| `--model <slug>` | Модель агента; по умолчанию `composer-2.5` |
| `--cursor-bin <path>` | Путь к бинарнику `cursor-agent` (на Windows — versioned `.cmd`, см. ниже) |
| `--no-engine` | Собрать контекст и записать `.mira/context.json`, **без** вызова агента |
| `--keep` | Не удалять checkout после завершения (для временного workspace по умолчанию удаляется, если не `--keep`) |

Примеры:

```bash
# Полный прогон с ревью
node src/entrypoints/cli/index.ts poc --project group/my-app --mr 42

# Отладка контекста без расхода Cursor
node src/entrypoints/cli/index.ts poc --project 123 --mr 7 --no-engine --keep

# Явный путь к агенту и модель
node src/entrypoints/cli/index.ts poc --project group/my-app --mr 42 \
  --cursor-bin "%LOCALAPPDATA%\cursor-agent\versions\2025.6.1\cursor-agent.cmd" \
  --model composer-2.5
```

---

## Что происходит по шагам

Оркестрация в `runPoc()` (`poc.ts`):

1. **Загрузка конфига** — `loadConfig()` из env (токены GitLab/Kaiten/Cursor).
2. **Чтение MR** — `GitLabReader.getMrContext(projectId, mrIid)`: title, description, ветки, список изменённых файлов, `headSha`.
3. **Checkout** — `prepareCheckout()`: clone/fetch, checkout `sourceBranch`, diff `targetBranch...sourceBranch` в эфемерный workspace (`buildCloneUrl` с `GITLAB_TOKEN`).
4. **Связка с Kaiten** — `resolveCard()` по title/description/ветке MR; если карточка найдена — в контекст попадают описание и критерии приёмки, иначе ревью «по diff only» (warning в лог).
5. **Сборка `ReviewContext`** — `assembleReviewContext(mr, diff, card?)`.
6. **Сохранение контекста** — `workspace/.mira/context.json` (JSON для отладки).
7. **Движок** (если не `--no-engine`) — `CliHeadlessEngine.review(context)`:
   - рендер `prompts/review.v1.md` с подстановкой `{{task.*}}`, `{{mr.*}}`, `{{changed_files}}`, `{{ignored_globs}}`;
   - spawn `cursor-agent` в каталоге checkout;
   - парсинг `findings.json` или fenced JSON из stdout;
   - валидация по `schema/findings.schema.json`.
8. **Вывод** — `formatReviewSummary()`: verdict, счётчики по severity, список находок, `requirements_coverage`, degradations, summary.
9. **Очистка** — временный workspace удаляется, если не задан `--workspace` и не `--keep`.

Схема находок и поля — [finding-schema.md](../03-reference/finding-schema.md). Пайплайн в прод-сервисе — [review-pipeline.md](../04-architecture/review-pipeline.md).

---

## Вызов `cursor-agent` (концептуально)

`CliHeadlessEngine` (`src/adapters/engine/cli/cli-headless-engine.ts`) запускает процесс:

```text
cursor-agent -p --output-format json --model <model> --force --trust
```

- **cwd** — каталог checkout MR (агент видит файлы и diff локально).
- **stdin** — полный текст промпта (из `prompts/review.v1.md` после `renderPrompt()`).
- **env** — `process.env` + `CURSOR_API_KEY` из конфига.
- **Таймаут** — 600 000 ms (10 мин); при таймауте процесс abort'ится.
- **Результат** — агент должен записать `./findings.json` в workspace **и** echo того же JSON в fenced ` ```json ` блок; engine читает файл в приоритете, затем stdout.
- **Retry** — один повтор, если exit code 0, но JSON не извлечён или не прошёл схему.

Шаблон промпта: `prompts/review.v1.md` (`prompt_version: review.v1`). Плейсхолдеры: `{{task.title}}`, `{{task.description}}`, `{{task.acceptance_criteria}}`, `{{mr.iid}}`, `{{mr.source_branch}}`, `{{mr.target_branch}}`, `{{mr.sha}}`, `{{changed_files}}`, `{{ignored_globs}}`.

По умолчанию engine игнорирует lock-файлы, `dist/`, `node_modules/` и т.п. (`DEFAULT_IGNORED_GLOBS` в `cli-headless-engine.ts`). В PoC политика YAML **не** подмешивается — используются дефолты engine.

---

## Windows: путь к `cursor-agent`

Корневая обёртка `cursor-agent.cmd` / `.ps1` может быть сломана («No version directories»). Укажите versioned binary:

```text
%LOCALAPPDATA%\cursor-agent\versions\<version>\cursor-agent.cmd
```

через флаг `--cursor-bin` в PoC. В основном сервисе (`main.ts`) — env `CURSOR_AGENT_BIN`.

---

## Типичные ошибки

| Симптом | Что проверить |
| --- | --- |
| `Missing required environment variable: …` | `.env` и обязательные переменные из `loadConfig()` |
| `Missing required flag: --project` / `--mr` | Флаги CLI; при ошибке парсинга печатается `usage()` |
| `poc failed: MR … not found` | `--project` / `--mr`, права `GITLAB_TOKEN` |
| `cursor-agent exited with code …` | `CURSOR_API_KEY`, `--cursor-bin`, модель в `--list-models` |
| `No linked card` (warning) | ID карточки в MR/ветке; Kaiten read-only токен |

---

## Дальше

- Настройка списка проектов для poller — [configure-project-policy.md](./configure-project-policy.md)
- Локальный dev loop — [local-development.md](./local-development.md)
- Полный сервис (poller + worker) — `npm run start:ts`, [deployment.md](../05-operations/deployment.md)
