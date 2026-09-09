# Tech Stack & Commands

## Стек

| Слой | Выбор |
| --- | --- |
| Язык | TypeScript (strict), ESM (`"type": "module"`) |
| Runtime | Node.js **≥24** — запускает `.ts` нативно (`node src/...ts`), без ts-node |
| Сборка | `tsc` → `dist/` (NodeNext, `allowImportingTsExtensions` + `rewriteRelativeImportExtensions`) |
| Движок ревью | Cursor `cursor-agent` (CLI headless) сейчас; `@cursor/sdk` — позже |
| Валидация схем | `ajv` (JSON-схема находок) |
| Конфиг-файлы | `yaml` (policy config) |
| Хранилище | встроенный `node:sqlite` (дефолт); опц. **Postgres** (`pg`) при масштабе |
| Очередь | in-process (дефолт); опц. **Redis** (`ioredis`) для нескольких worker'ов |
| Линт/формат | `oxlint` + `oxfmt` |
| Тесты | встроенный `node --test`; co-located `src/**/*.test.ts` |

Зависимости намеренно минимальны: `@cursor/sdk`, `ajv`, `yaml` (prod);
`oxlint`, `oxfmt`, `typescript`, `@types/node` (dev).

## Команды проверок (из `package.json`)

```bash
npm run typecheck     # tsc --noEmit для src + tsconfig.test.json (co-located *.test.ts)
npm run lint          # oxlint
npm run lint:fix      # oxlint --fix
npm run format        # oxfmt (без *.md)
npm run format:check  # oxfmt --check
npm test              # node --test src/**/*.test.ts
npm run build         # tsc -p tsconfig.json → dist/
```

Запуск сервиса:

```bash
npm start             # node dist/entrypoints/main.js  (после build)
npm run start:ts      # node src/entrypoints/main.ts    (без сборки)
npm run dev           # node --watch src/entrypoints/cli/index.ts
```

**Перед коммитом** (рекомендуемый минимум): `typecheck` + `lint` + `test`.

## Окружение (ENV)

Обязательные (валидируются на старте в `src/config/index.ts`, иначе ранний fail):

| Переменная | Назначение |
| --- | --- |
| `CURSOR_API_KEY` | ключ Cursor с доступом к `composer-2.5` |
| `GITLAB_BASE_URL`, `GITLAB_TOKEN` | чтение MR/контекста (read; write — позже) |
| `KAITEN_BASE_URL`, `KAITEN_TOKEN` | чтение карточек — **только read** |

Опциональные (читаются в `entrypoints/main.ts`): `ROLE` (`all`\|`api`\|`poller`\|`worker`),
`MIRA_POLICY_CONFIG`, `MIRA_DB_PATH`, `WORKSPACE_ROOT`, `MAX_CONCURRENCY`,
`POLL_INTERVAL_MS`, `HEALTH_PORT`, `CURSOR_AGENT_BIN`, `MIRA_ADMIN_TOKEN`,
`MIRA_ENV_FILE`. Live-ротация ключей — `PUT /admin/secrets` (ADR 019).

Ускорители (опц., дефолты сохраняют MVP-поведение — см.
[`docs/02-guides/performance-scaling.md`](../02-guides/performance-scaling.md)):
`MIRA_QUEUE` (`inproc`\|`redis` + `REDIS_URL`, `MIRA_QUEUE_PREFIX`),
`MIRA_STORE` (`sqlite`\|`postgres` + `DATABASE_URL`),
`MIRA_CHECKOUT` (`fresh`\|`mirror` + `MIRA_CHECKOUT_CACHE_DIR`),
`MIRA_READ_CACHE` (`on`\|`off` + `MIRA_READ_CACHE_TTL_MS`).

Шаблон — [`.env.example`](../../.env.example). Деплой/конфиг —
[`docs/05-operations/deployment.md`](../05-operations/deployment.md), `deploy/`.

## Внешние сервисы

GitLab (self-hosted), Kaiten, Cursor API. Связки и токены —
[`integrations.md`](./integrations.md).

## Платформенные заметки

- Windows: корневая обёртка `cursor-agent.cmd` может быть сломана — звать
  versioned `.cmd` (или задать `CURSOR_AGENT_BIN`).
