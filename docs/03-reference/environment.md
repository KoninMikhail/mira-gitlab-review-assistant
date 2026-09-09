# Переменные окружения

Источники: `src/config/index.ts`, `src/entrypoints/main.ts`, `.env.example`, `deploy/docker-compose.yml`.

Загрузка обязательных переменных — `loadConfig()` при старте; первая отсутствующая → `ConfigError`. Перед этим `main` / CLI читают файл `MIRA_ENV_FILE` (дефолт `.env`) в пустые ключи `process.env`, не перезаписывая уже заданные ENV.

Токены Cursor / GitLab / Kaiten можно сменить на живом процессе через `PUT /admin/secrets` (см. ниже) — рестарт не нужен.

## Обязательные

| Переменная | Назначение | Пример |
| --- | --- | --- |
| `CURSOR_API_KEY` | API-ключ Cursor для `cursor-agent` / Composer | — |
| `GITLAB_BASE_URL` | Базовый URL GitLab **без** `/api/v4` | `https://gitlab.example.com` |
| `GITLAB_TOKEN` | Токен доступа (`PRIVATE-TOKEN`) | — |
| `KAITEN_BASE_URL` | Базовый URL пространства Kaiten **без** `/api/latest` | `https://your-space.kaiten.ru` |
| `KAITEN_TOKEN` | Bearer-токен Kaiten (**только чтение** в MVP) | — |

## Опциональные

| Переменная | Назначение | Значение по умолчанию | Где читается |
| --- | --- | --- | --- |
| `ROLE` | Роль процесса сервиса | `all` | `main.ts` → `parseRole()` |
| `MIRA_POLICY_CONFIG` | Путь к YAML policy | не задан → встроенные defaults, `discovery.projects: []` | `main.ts` → `loadPolicy()` |
| `MIRA_PROFILES_DIR` | Директория стек-профилей (`profiles/<name>.md`) | `profiles` (в корне) | `main.ts` → `loadStackProfiles()` |
| `MIRA_DB_PATH` | Путь к SQLite state store | `mira.db` | `main.ts` |
| `WORKSPACE_ROOT` | Корень для git checkout MR | не задан → checkout в temp | `main.ts` → `workspaceRoot()` |
| `MAX_CONCURRENCY` | Параллельные worker-задачи | `1` (невалидное / ≤0 → `1`) | `main.ts` → `concurrency()` |
| `POLL_INTERVAL_MS` | Интервал poller, мс | `60000` (невалидное / ≤0 → `60000`) | `main.ts` → `pollIntervalMs()` |
| `HEALTH_PORT` | Порт HTTP `/healthz` и `/admin/secrets` | `8080` (невалидное / ≤0 → `8080`) | `main.ts` → `healthPort()` |
| `CURSOR_AGENT_BIN` | Путь к бинарнику `cursor-agent` | `cursor-agent` (в PATH) | `main.ts` → `engineOptions()` |
| `MIRA_ADMIN_TOKEN` | Bearer / `X-Mira-Admin-Token` для `/admin/secrets` | пусто → только loopback | `main.ts` → `runApiServer` |
| `MIRA_ENV_FILE` | dotenv-файл: старт + persist после PUT | `.env` (пустая строка = выкл) | `main.ts` → `envFilePath()` |

## `ROLE`

| Значение | Поведение |
| --- | --- |
| `all` | poller + worker + `/healthz` + `/admin/secrets` (default) |
| `poller` | Только discovery MR и enqueue |
| `worker` | Только consume очереди и ревью |
| `api` | `/healthz` + `/admin/secrets` (+ webhook) |

Неизвестное значение → fatal: `Unknown ROLE: … (expected all|api|poller|worker)`.

## Константы composition root (не env)

| Имя | Значение | Назначение |
| --- | --- | --- |
| `PROMPT_VERSION` | `review.v1` | Версия промпта для idempotency (`ReviewKey`) |
| `PARTITION_VERSION` | `single.v1` | Версия декомпозиции для idempotency |

При выбранном стек-профиле к `PROMPT_VERSION` в ключе добавляется отпечаток профиля:
`review.v1+<name>@<sha8>` (правка `profiles/<name>.md` → переревью). См.
[review-profiles.md](./review-profiles.md).

## HTTP endpoints

| Путь | Ответ |
| --- | --- |
| `GET /healthz` | `200`, `{"status":"ok"}` |
| `GET /admin/secrets` | `200`, `{"CURSOR_API_KEY":"set"|"missing", ...}` — без значений |
| `PUT /admin/secrets` | JSON с подмножеством `CURSOR_API_KEY` / `GITLAB_TOKEN` / `KAITEN_TOKEN`; `200` `{"updated":[...]}` |
| `POST /admin/secrets/reload` | Перечитать `MIRA_ENV_FILE`; `200` `{"updated":[...]}` |
| прочие | `404` |

`/admin/secrets` живёт на ролях `api` и `all`. Auth: `Authorization: Bearer <MIRA_ADMIN_TOKEN>` или заголовок `X-Mira-Admin-Token`. Если токен пуст — только запросы с `127.0.0.1` / `::1` (локальный DX). `401` без значений ключей.

Пример (процесс слушает `HEALTH_PORT`, дефолт 8080):

```bash
curl -sS -X PUT http://127.0.0.1:8080/admin/secrets \
  -H "content-type: application/json" \
  -d "{\"CURSOR_API_KEY\":\"key_...\"}"
```

## Пример `.env`

См. `.env.example` в корне репо.

## См. также

- [policy-config.md](./policy-config.md) — содержимое `MIRA_POLICY_CONFIG`
- [review-profiles.md](./review-profiles.md) — стек-профили и `MIRA_PROFILES_DIR`
- [cli.md](./cli.md) — CLI `poc` (те же обязательные env через `loadConfig()`)
- [../05-operations/security.md](../05-operations/security.md)
