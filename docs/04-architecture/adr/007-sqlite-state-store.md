# 007. SQLite как state store MVP

- Статус: Принято (Accepted)
- Дата: 2026-06
- Контекст-ссылки: [../review-pipeline.md](../review-pipeline.md), [../../01-concepts/roadmap.md](../../01-concepts/roadmap.md), [005-fixed-model-composer-2-5.md](./005-fixed-model-composer-2-5.md)

## Контекст

Воркер **stateless** — всё состояние снаружи. Нужно хранить: обработанные комбинации
MR+SHA, опубликованные находки, игнор-лист, метрики прогонов. Идемпотентность
запуска — ключ `(project_id, mr_iid, commit_sha)` **с учётом версий поведения**
(`prompt_version`, `partition_version`), иначе смена промпта «молча» пропустит
пересмотр.

На старте — один сервер, небольшая нагрузка; Postgres — избыточен для MVP.

## Решение

**State store MVP — SQLite** через встроенный модуль **`node:sqlite`** (`DatabaseSync`).
Адаптер: `src/adapters/store/sqlite/` (`SqliteStateStore`).

Схема (упрощённо):

- **`MR_REVIEW`** — первичный ключ `(project_id, mr_iid, head_sha, prompt_version,
  partition_version)`; поля `verdict`, `summary`, `created_at`;
- **`FINDING_RECORD`** — находки прогона с `fingerprint`, severity, category, путь;
- **`MR_IGNORE`** — игнор-лист для `@mira ignore <fingerprint>` (фаза 2).

Идемпотентность:

- `seen(key)` — проверка перед работой воркера;
- `record(key, result)` — фиксация после успешного прогона;
- смена `prompt_version` или `partition_version` → новый ключ → допустимый повторный
  прогон на том же SHA.

**Postgres** — целевой store при росте (фаза 3+, несколько воркеров с общим state),
за тем же портом `StateStore`.

## Последствия

**Плюсы:**

- Нулевая операционная сложность: один файл БД, без отдельного сервиса;
- встроен в Node ≥24 — без native-зависимостей;
- транзакции `BEGIN IMMEDIATE` при записи review + findings;
- `:memory:` для тестов.

**Минусы:**

- Один writer — не подходит для многих параллельных воркеров на разных хостах без
  блокировок/репликации;
- бэкапы и миграции — на нас; при переходе на Postgres нужна миграция данных.

**Включает:** порт `StateStore` + `IgnoreStore`; детали идемпотентности —
[../review-pipeline.md](../review-pipeline.md).

## Альтернативы

| Вариант | Почему отклонён для MVP |
| --- | --- |
| Postgres с первого дня | Лишняя инфраструктура на одном сервере |
| Redis только | Слабее для истории находок и аналитики; нужен второй слой |
| In-memory Map | Потеря state при рестарте; нет идемпотентности между процессами |
| Файловый JSON | Гонки при параллельных воркерах; нет транзакций |
| Идемпотентность только по `(mr, sha)` без версий | Смена промпта не триггерит пересмотр; метрики несопоставимы |
