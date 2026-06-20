# 002. TypeScript и `@cursor/sdk` вместо Python

- Статус: Принято (Accepted)
- Дата: 2026-06
- Контекст-ссылки: [004-review-engine-port-cli-then-sdk.md](./004-review-engine-port-cli-then-sdk.md), [../../03-reference/environment.md](../../03-reference/environment.md)

## Контекст

Сервис Mira — **событийный I/O-оркестратор**: webhook/polling, очередь, множество
одновременных ожиданий внешних API, стриминг прогона агента. Cursor предоставляет
два официальных SDK: TypeScript (`@cursor/sdk`) и Python (`cursor-sdk`). Нужно
зафиксировать язык реализации (вопрос **Q-5**).

## Решение

**TypeScript (ESM, Node ≥24)** как основной язык сервиса и **`@cursor/sdk`** как
целевой SDK-адаптер движка ревью.

Обоснование:

- async-by-default модель Node естественно ложится на webhook + queue + `run.wait()` /
  `run.stream()` без разделения sync/async-путей;
- `await using` для жизненного цикла агента;
- меньше трения с экосистемой Cursor (CLI headless, MCP, hooks) на том же стеке;
- один репозиторий, один `package.json`, модульный монолит (см.
  [003-modular-monolith-roles.md](./003-modular-monolith-roles.md)).

Python (`cursor-sdk` + `AsyncClient.launch_bridge`) документирован как **рабочая
альтернатива** при смене команды поддержки, но не выбран по умолчанию.

## Последствия

**Плюсы:**

- Единый стек TS для CLI-адаптера MVP и SDK-адаптера прод;
- нативный запуск `.ts` в Node ≥24 без отдельного bundler на dev-пути;
- типизированные порты и конфиг.

**Минусы:**

- Команда без опыта TS/Node — кривая обучения (Python был бы привычнее);
- при миграции на Python пришлось бы дублировать всю структуру `core`/`adapters`.

**Включает:** `@cursor/sdk` в зависимостях; адаптер `src/adapters/engine/sdk/` —
целевой для фазы 3; CLI остаётся на фазе 1–2.

## Альтернативы

| Вариант | Почему отклонён |
| --- | --- |
| Python + `cursor-sdk` | sync-by-default; для сервера нужен `AsyncClient.launch_bridge` и разделение путей; менее естественная интеграция с Node-экосистемой Cursor |
| Go / Rust | Нет официального Cursor SDK; высокая стоимость обёртки CLI |
| Два языка (оркестратор на Python, движок на TS) | Дублирование контрактов, сложный деплой |
