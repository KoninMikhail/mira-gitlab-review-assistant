# 012. Не запускать через GitLab CI/CD pipelines

- Статус: Принято (Accepted)
- Дата: 2026-06
- Контекст-ссылки: [../../01-concepts/overview.md](../../01-concepts/overview.md), [../triggers.md](../triggers.md), [006-polling-trigger-mvp.md](./006-polling-trigger-mvp.md)

## Контекст

GitLab CI/CD — естественное место для автоматизации вокруг MR, но заказчик и
требования явно исключили запуск Mira как **job в `.gitlab-ci.yml`**. Цель **G5**:
Mira — **отдельный сервис на выделенном сервере** с Cursor CLI, а не этап pipeline.
Non-goal **N1**: не подменять CI (тесты/линтеры Mira не запускает как обязательный
этап).

Нужно зафиксировать границу, чтобы не смешивать webhook-интеграцию GitLab с
pipeline job.

## Решение

**Mira не запускается через GitLab CI/CD pipelines.** Это архитектурное ограничение
(**C-1**), не временный компромисс.

Импликации:

- триггеры — **polling**, **webhook** (HTTP интеграция проекта/группы), **ChatOps**
  — инициируются сервисом Mira или событиями GitLab **вне** pipeline;
- **webhook ≠ pipeline**: Merge Request Hook / Note Hook не требуют `.gitlab-ci.yml`
  и не нарушают C-1;
- деплой — standalone server / Docker (`ROLE=api|worker|poller`), не `image:` job в
  CI репозитория-потребителя;
- Mira **не merge gate**, **не approve**, **не блокирует** pipeline.

Mira может **читать** артефакты/статус CI как контекст ревью (будущее), но **не
исполняет** CI-задачи.

## Последствия

**Плюсы:**

- Независимый жизненный цикл и ресурсы (CPU/RAM Cursor) от runner'ов проектов;
- единый сервер для всех репозиториев группы без правок `.gitlab-ci.yml` в каждом
  репо;
- чёткое разделение: CI = проверки, Mira = консультативное AI-ревью.

**Минусы:**

- Отдельная инфраструктура и эксплуатация сервера Mira;
- нельзя «включить бота» одной строкой в `.gitlab-ci.yml` — нужен enrollment и
  сервис.

**Включает:** цель G5 в overview; все варианты движка в
[004-review-engine-port-cli-then-sdk.md](./004-review-engine-port-cli-then-sdk.md) —
процесс на сервере Mira.

## Альтернативы

| Вариант | Почему отклонён |
| --- | --- |
| GitLab CI job с `cursor-agent` | Прямое нарушение C-1/G5; зависимость от runner'ов каждого проекта |
| Shared runner с matrix по MR | Тот же pipeline-путь; фрагментация секретов и Cursor |
| Только scheduled CI pipeline | Нет реактивности; смешение с CI non-goals |
| GitLab Duo / встроенный AI вместо Mira | Другой продукт; не контекст Kaiten и кастомная политика |
