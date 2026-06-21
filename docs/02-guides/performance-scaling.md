# Ускорение и масштабирование (Redis, Postgres, кэш чекаута)

Как ускорить Mira Review Bot под нагрузкой с помощью **опциональных** инструментов.
Все они выключены по умолчанию — базовый сервис (один процесс, SQLite, in-proc
очередь) работает без них. Включаются переменными окружения, код ядра не меняется
(гексагон: новые адаптеры за существующими портами).

> Что есть что: справочник ENV — [`environment.md`](../03-reference/environment.md);
> архитектура портов — [`overview`](../04-architecture/overview.md); пайплайн —
> [`review-pipeline.md`](../04-architecture/review-pipeline.md).

## Сначала — где «узко»

Стоимость одного ревью почти целиком в прогоне `cursor-agent` (минуты). Поэтому:

- **Redis НЕ ускоряет одно ревью** — он даёт **пропускную способность**: несколько
  worker-процессов тянут из одной очереди и ревьюят разные MR параллельно.
- **Кэш чекаута** — единственный прямой выигрыш по времени на каждом ревью
  (переиспользование git-объектов вместо полного клона).
- **TTL-кэш Kaiten** — экономит сетевые обращения к карточкам.

Рекомендация по порядку внедрения: сначала **кэш чекаута** (не нужна внешняя
инфраструктура), затем **Redis + Postgres** — когда упёрлись в один процесс.

---

## 1. Кэш чекаута (`MIRA_CHECKOUT=mirror`)

Вместо свежего `git clone` на каждый job поддерживается персистентный bare-«зеркало»
объектов; эфемерный воркспейс клонируется с `--reference` и переиспользует объекты.
Очистка воркспейса не меняется (обычный `rm`, без worktree-учёта).

```bash
MIRA_CHECKOUT=mirror
# по умолчанию: <WORKSPACE_ROOT|tmpdir>/mira-mirror-cache
MIRA_CHECKOUT_CACHE_DIR=/var/cache/mira/mirrors
```

- Кэш-каталог должен **переживать рестарты** (persistent volume) — иначе выигрыша нет.
- При нескольких worker-подах кэш можно положить на общий том (каждый репо — свой
  bare-каталог, ключ выводится из URL без токена).
- Внешних зависимостей не требует, только `git` и диск.

## 2. Распределённая очередь (`MIRA_QUEUE=redis`)

Общая Redis-очередь вместо in-process. Позволяет поднять **несколько worker'ов**
(процессов/подов) на одну очередь; дедуп по `(project, mr, sha)` через Redis-SET
переживает рестарты.

```bash
MIRA_QUEUE=redis
REDIS_URL=redis://localhost:6379
MIRA_QUEUE_PREFIX=mira   # ключи: mira:queue (список), mira:pending (set дедупа)
```

- Требует пакет **`ioredis`** (`optionalDependencies`) — установить на деплое:
  `npm install ioredis` (или `npm install` подтянет optional-зависимости).
- FIFO: `enqueue` → `rpush`, `take` → `blpop` (поллинг 1 c, чтобы реагировать на
  shutdown). `enqueue` возвращает `false`, если такой job уже в очереди (дедуп).
- **Важно:** при масштабе >1 worker включайте вместе с Postgres (см. ниже) — SQLite
  однописательный и под несколькими процессами начнёт блокироваться.

### Запуск нескольких worker'ов

Очередь общая, поэтому можно запускать роль `worker` в нескольких экземплярах:

```bash
ROLE=poller  MIRA_QUEUE=redis REDIS_URL=...                  npm run start:ts  # один поллер
ROLE=worker  MIRA_QUEUE=redis REDIS_URL=... MIRA_STORE=postgres DATABASE_URL=... npm run start:ts  # worker #1
ROLE=worker  MIRA_QUEUE=redis REDIS_URL=... MIRA_STORE=postgres DATABASE_URL=... npm run start:ts  # worker #2
```

`MAX_CONCURRENCY` управляет числом одновременных ревью **внутри одного** процесса;
число процессов `worker` — внешнее горизонтальное масштабирование.

## 3. Postgres state store (`MIRA_STORE=postgres`)

Для конкурентной записи из нескольких worker'ов. Семантика идемпотентности та же,
что у SQLite (`seen`/`record`, ignore-список), схема создаётся автоматически
(`CREATE TABLE IF NOT EXISTS`).

```bash
MIRA_STORE=postgres
DATABASE_URL=postgres://mira:mira@localhost:5432/mira   # или POSTGRES_URL
```

- Требует пакет **`pg`** (`optionalDependencies`): `npm install pg`.
- Таблицы: `mr_review`, `finding_record`, `mr_ignore` (миграция лениво на первом
  обращении).

## 4. TTL-кэш чтения Kaiten (`MIRA_READ_CACHE=on`)

Кэширует результат `getCard(cardId)` в памяти на TTL — много MR ссылаются на одну
карточку, а карточка редко меняется в окне ревью. Остаётся **read-only** (правило
`kaiten-read-only`).

```bash
MIRA_READ_CACHE=on
MIRA_READ_CACHE_TTL_MS=300000   # 5 минут по умолчанию
```

Кэш per-process (in-memory). При нескольких подах каждый держит свой кэш — это
нормально для редко меняющихся карточек.

---

## Профили запуска

| Профиль | ENV | Когда |
| --- | --- | --- |
| MVP (по умолчанию) | — | пилот, низкий поток MR, один узел |
| Один узел, быстрее | `MIRA_CHECKOUT=mirror`, `MIRA_READ_CACHE=on` | тот же узел, меньше времени на чекаут/сеть |
| Горизонтальный масштаб | `MIRA_QUEUE=redis` + `MIRA_STORE=postgres` (+ mirror на общем томе) | много MR, несколько worker-подов |

## Матрица совместимости / подводные камни

- `MIRA_QUEUE=redis` без `REDIS_URL` → ранний fail на старте (намеренно).
- `MIRA_STORE=postgres` без `DATABASE_URL`/`POSTGRES_URL` → ранний fail.
- Несколько worker'ов + `MIRA_STORE=sqlite` → блокировки записи; используйте Postgres.
- `MIRA_CHECKOUT=mirror` с эфемерным (не persistent) кэш-каталогом → выигрыша нет.
- `ioredis`/`pg` не установлены, но режим включён → ошибка ленивого импорта при старте;
  установите соответствующий пакет.

## Проверка

```bash
npm run typecheck && npm run lint && npm test
```

Адаптеры покрыты unit-тестами с фейками (без реального Redis/Postgres/git): см.
`src/adapters/queue/redis/`, `src/adapters/store/postgres/`, `src/adapters/cache/`,
`src/core/context/mirror-checkout.test.ts`.
