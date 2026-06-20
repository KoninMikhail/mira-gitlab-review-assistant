# Переменные окружения

Источники: `src/config/index.ts`, `src/entrypoints/main.ts`, `.env.example`, `deploy/docker-compose.yml`.

Загрузка обязательных переменных — `loadConfig()` при старте; первая отсутствующая → `ConfigError`.

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
| `MIRA_DB_PATH` | Путь к SQLite state store | `mira.db` | `main.ts` |
| `WORKSPACE_ROOT` | Корень для git checkout MR | не задан → checkout в temp | `main.ts` → `workspaceRoot()` |
| `MAX_CONCURRENCY` | Параллельные worker-задачи | `1` (невалидное / ≤0 → `1`) | `main.ts` → `concurrency()` |
| `POLL_INTERVAL_MS` | Интервал poller, мс | `60000` (невалидное / ≤0 → `60000`) | `main.ts` → `pollIntervalMs()` |
| `HEALTH_PORT` | Порт HTTP `/healthz` | `8080` (невалидное / ≤0 → `8080`) | `main.ts` → `healthPort()` |
| `CURSOR_AGENT_BIN` | Путь к бинарнику `cursor-agent` | `cursor-agent` (в PATH) | `main.ts` → `engineOptions()` |

## `ROLE`

| Значение | Поведение |
| --- | --- |
| `all` | poller + worker + `/healthz` (default) |
| `poller` | Только discovery MR и enqueue |
| `worker` | Только consume очереди и ревью |
| `api` | Только `/healthz` |

Неизвестное значение → fatal: `Unknown ROLE: … (expected all|api|poller|worker)`.

## Константы composition root (не env)

| Имя | Значение | Назначение |
| --- | --- | --- |
| `PROMPT_VERSION` | `review.v1` | Версия промпта для idempotency (`ReviewKey`) |
| `PARTITION_VERSION` | `single.v1` | Версия декомпозиции для idempotency |

## Health endpoint

| Путь | Ответ |
| --- | --- |
| `GET /healthz` | `200`, `{"status":"ok"}` |
| прочие | `404` |

## Пример `.env`

См. `.env.example` в корне репо.

## См. также

- [policy-config.md](./policy-config.md) — содержимое `MIRA_POLICY_CONFIG`
- [cli.md](./cli.md) — CLI `poc` (те же обязательные env через `loadConfig()`)
- [../05-operations/security.md](../05-operations/security.md)
