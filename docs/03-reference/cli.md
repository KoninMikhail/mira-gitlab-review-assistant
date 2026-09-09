# CLI и entrypoints

## npm scripts

| Script | Команда | Назначение |
| --- | --- | --- |
| `start:ts` | `node src/entrypoints/main.ts` | MVP-сервис (composition root) |
| `start` | `node dist/entrypoints/main.js` | Production build |
| `dev` | `node --watch src/entrypoints/cli/index.ts` | CLI с hot reload |

---

## `main.ts` — сервисный entrypoint

Файл: `src/entrypoints/main.ts`.

| Env `ROLE` | Компоненты |
| --- | --- |
| `all` (default) | poller + worker + `/healthz` + `/admin/secrets` |
| `poller` | `runPoller()` |
| `worker` | `runWorker()` + pipeline |
| `api` | `GET /healthz`, `/admin/secrets`, webhook |

**Wiring (MVP):**

| Зависимость | Реализация |
| --- | --- |
| VCS read / list | `GitLabReader` |
| Task tracker | `KaitenTracker` |
| Queue | `InProcQueue` |
| State | `SqliteStateStore` |
| Engine | `CliHeadlessEngine` (factory per checkout) |
| Publisher | `LogPublisher` (dry-run) |

**Версии idempotency:** `promptVersion: review.v1`, `partitionVersion: single.v1`.

**Сигналы:** `SIGINT` / `SIGTERM` → abort + `queue.close()` + `store.close()`.

---

## CLI `mira` — ручной PoC

Entry: `src/entrypoints/cli/index.ts` → subcommand `poc` (`src/entrypoints/cli/poc.ts`).

### Команды

| Команда | Описание |
| --- | --- |
| `mira help` | Справка |
| `mira poc …` | Ревью одного MR (phase 0) |

### `mira poc`

**Usage:**

```
mira poc --project <id> --mr <iid> [options]
```

| Флаг | Обяз. | Описание | Default |
| --- | --- | --- | --- |
| `--project <id>` | да | Numeric ID или `group/sub/project` | — |
| `--mr <iid>` | да | MR IID (целое > 0) | — |
| `--workspace <dir>` | нет | Директория checkout | temp под `os.tmpdir()` |
| `--model <slug>` | нет | Модель Cursor | `composer-2.5` |
| `--cursor-bin <path>` | нет | Путь к `cursor-agent` | `cursor-agent` |
| `--no-engine` | нет | Собрать context, пропустить agent | `false` |
| `--keep` | нет | Не удалять checkout после run | `false` |

**Env:** те же обязательные, что у сервиса (`loadConfig()`).

**Поток:** GitLab MR → checkout → resolve Kaiten card → `ReviewContext` → engine → console summary.

**Артефакт:** `.mira/context.json` в workspace.

**Exit code:** `1` при ошибке args или run.

---

## `CliHeadlessEngine` / `cursor-agent`

Файл: `src/adapters/engine/cli/cli-headless-engine.ts`.

### Вызов

```text
cursor-agent -p --output-format json --model <model> --force --trust
```

| Параметр | Default | Override |
| --- | --- | --- |
| binary | `cursor-agent` | env `CURSOR_AGENT_BIN` (service) / `--cursor-bin` (poc) |
| model | `composer-2.5` | policy `model` / `--model` |
| prompt | `prompts/review.v1.md` | `promptPath` option |
| cwd | MR checkout (`workspaceDir`) | — |
| stdin | rendered prompt | — |
| env | `CURSOR_API_KEY` + `process.env` | — |
| timeout | `600_000` ms (10 min) | `timeoutMs` option |

### Плейсхолдеры промпта

| Placeholder | Источник |
| --- | --- |
| `{{task.title}}` | `TaskCard.title` или fallback |
| `{{task.description}}` | `TaskCard.description` |
| `{{task.acceptance_criteria}}` | bullet list из `acceptanceCriteria` |
| `{{mr.iid}}` | `context.job.mrIid` |
| `{{mr.source_branch}}` | `context.sourceBranch` |
| `{{mr.target_branch}}` | `context.targetBranch` |
| `{{mr.sha}}` | `context.job.headSha` |
| `{{changed_files}}` | список `ChangedFile` |
| `{{ignored_globs}}` | policy / engine globs |

### Retry

| Условие | Поведение |
| --- | --- |
| exit ≠ 0 | throw, без retry |
| timeout | throw, без retry |
| exit 0, JSON invalid | 1 retry (удаляет stale `findings.json`) |

### Windows

Root wrapper `cursor-agent.cmd` может быть сломан — указывать versioned binary, напр. `...\versions\<ver>\cursor-agent.cmd`.

---

## Poller (кратко)

`src/entrypoints/poller/poller.ts`:

- `runPoller({ intervalMs, signal, … })` — tick сразу, затем каждые `POLL_INTERVAL_MS`
- `selectJobs()` — skip draft, не-`opened`, already handled; trigger `open` или `ready` по policy
- `push` / `reopen` poller **не** эмулирует

---

## См. также

- [environment.md](./environment.md)
- [integrations-api.md](./integrations-api.md)
- [../02-guides/run-review-poc.md](../02-guides/run-review-poc.md)
