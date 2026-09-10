# 021. Фиксированная модель `cursor-grok-4.6[fast=true]`

- Статус: Заменено (Superseded)

> **Superseded by** [022-cursor-grok-4-6-high-fast-slug.md](./022-cursor-grok-4-6-high-fast-slug.md).
- Дата: 2026-09
- Контекст-ссылки: [005-fixed-model-composer-2-5.md](./005-fixed-model-composer-2-5.md),
  [../decomposition-context-budget.md](../decomposition-context-budget.md)

> Заменяет [005-fixed-model-composer-2-5.md](./005-fixed-model-composer-2-5.md).

## Контекст

Качество ревью и воспроизводимость метрик по-прежнему требуют **фиксированного**
slug (не `auto`, ADR 005). Composer 2.5 больше не базовая модель команды: для
длинных headless-прогонов нужна Cursor Grok 4.6. Fast включаем явно; effort
оставляем дефолтом модели (сейчас High), без `-high` в slug.

## Решение

**Базовая модель — Cursor Grok 4.6 Fast** (`cursor-grok-4.6[fast=true]`):

- CLI: `--model "cursor-grok-4.6[fast=true]"`;
- SDK: `model: { id: "cursor-grok-4.6", params: [{ id: "fast", value: "true" }] }`.

В YAML slug **в кавычках**: `model: "cursor-grok-4.6[fast=true]"` — иначе `[...]`
читается как flow-sequence.

Не использовать `auto`. Не пинить effort (`high` / `medium`) в slug. Переопределение —
только осознанно через policy `model`.

## Альтернативы

| Вариант | Почему не выбран |
| --- | --- |
| Оставить `composer-2.5` | Слабее на длинных ревью |
| `cursor-grok-4.6-high-fast` | Пинит effort; дефолт Grok 4.6 и так High |
| `cursor-grok-4.6` без Fast | Медленнее CLI headless |
| `model: "auto"` | Невоспроизводимые метрики и стоимость |

## Последствия

- Fast у Grok 4.6 примерно в 2 раза дороже non-fast.
- Смена модели = новый прогон (ключ идемпотентности).
- `max_chunk_tokens` может понадобиться перекалибровать под окно Grok 4.6.

## References

- [005-fixed-model-composer-2-5.md](./005-fixed-model-composer-2-5.md)
