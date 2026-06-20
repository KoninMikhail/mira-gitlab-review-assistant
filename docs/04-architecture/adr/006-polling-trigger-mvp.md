# 006. MVP-триггер: polling по первичному состоянию MR

- Статус: Принято (Accepted)
- Дата: 2026-06
- Контекст-ссылки: [../triggers.md](../triggers.md), [../../01-concepts/roadmap.md](../../01-concepts/roadmap.md), [009-dry-run-publisher.md](./009-dry-run-publisher.md)

## Контекст

Mira должна узнавать о MR **без GitLab CI/CD pipelines** (ограничение **C-1** /
**G5**). Доступны webhook, polling и ChatOps. На старте GitLab MCP — **read-only**,
настройка webhook и bot write — требуют согласований. Нужен триггер для фазы 1 MVP,
совместимый с текущими правами.

Поведение по умолчанию: ревью **первичного состояния MR**, не каждого последующего
пуша (фиксы после ревью — шум и лишняя стоимость). Ре-ревью — `@mira review` или
политика `review_on`.

## Решение

**Фаза 1 (MVP): триггер — polling** открытых MR через GitLab Reader (`list_merge_requests`,
`state=opened`). Webhook и Note Hook — **фаза 2**. ChatOps — дополнение после webhook
или отдельного прохода по комментариям.

Алгоритм poller (идентичен логике webhook по политике `review_on: [open, ready, manual]`):

- впервые увиденный **не-draft** MR → постановка ревью;
- переход **draft → ready** (сравнение с state store) → ревью;
- новый `sha` без смены draft-статуса (фиксы) → **игнор по умолчанию**;
- `reopen` → ревью;
- merge/close → не ревьюить.

Все источники нормализуются в единый `ReviewJob` и кладутся в очередь — ядро не
зависит от способа обнаружения.

**Явно:** webhook ≠ pipeline; вебхуки GitLab — интеграция уровня проекта, не
`.gitlab-ci.yml`. Mira **не запускает CI** и **не является job пайплайна**.

## Последствия

**Плюсы:**

- Достаточно read-доступа к GitLab — совместимо с текущим MCP;
- минимум согласований для старта MVP;
- та же политика `review_on`, что и у целевого webhook — миграция без смены воркера.

**Минусы:**

- Латентность минуты (интервал 1–3 мин), не секунды;
- лишние запросы к GitLab API;
- мгновенный ChatOps без webhook недоступен.

**Включает:** `src/entrypoints/poller/`; in-process queue на фазе 1; webhook в
`src/entrypoints/api/` — код фазы 2, не дефолт MVP.

## Альтернативы

| Вариант | Почему отклонён для MVP |
| --- | --- |
| Webhook с первого дня | Нужны права на настройку webhook + секрет; блокирует старт при read-only |
| Ревью на каждый push | Шум в MR, лишняя стоимость; осознанный re-review через `@mira review` |
| Только ChatOps | Нет автоматического первого прохода; хуже G1 |
| GitLab CI job как триггер | Явное non-goal и ограничение C-1 (см. [012-no-gitlab-ci-pipelines.md](./012-no-gitlab-ci-pipelines.md)) |
