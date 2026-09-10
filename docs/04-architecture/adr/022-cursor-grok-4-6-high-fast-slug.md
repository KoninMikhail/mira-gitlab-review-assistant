# 022. Фиксированная модель `cursor-grok-4.6-high-fast`

- Статус: Принято (Accepted)
- Дата: 2026-09
- Контекст-ссылки: [021-fixed-model-cursor-grok-4-6-fast.md](./021-fixed-model-cursor-grok-4-6-fast.md)

> Заменяет [021-fixed-model-cursor-grok-4-6-fast.md](./021-fixed-model-cursor-grok-4-6-fast.md).

## Контекст

Cursor CLI (2026.09) убрал parameterized slug `cursor-grok-4.6[fast=true]`.
При `--model` с этим значением агент пишет `Cannot use this model` и выходит с
кодом 0. Mira принимала это за успешный прогон, не находила findings и
публиковала текст про «мёртвые ключи».

## Решение

**Базовая модель — Cursor Grok 4.6 Fast** через актуальный каталог CLI:
`cursor-grok-4.6-high-fast`.

- CLI: `--model cursor-grok-4.6-high-fast`;
- YAML: `model: "cursor-grok-4.6-high-fast"`;
- отказ модели / пустой JSON / сеть классифицируются отдельно, не как auth.

Не использовать `auto`. Старый bracket-slug не класть в policy.

## Альтернативы

| Вариант | Почему не выбран |
| --- | --- |
| Оставить `[fast=true]` | CLI отвергает, exit 0, ложный «ключи» |
| `cursor-grok-4.6-high` без Fast | Медленнее headless; Fast был целью ADR 021 |
| `model: "auto"` | Невоспроизводимые метрики |

## Последствия

- Effort High зашит в slug (каталог CLI больше не даёт Fast без effort).
- Смена модели = новый прогон (ключ идемпотентности).
- Прод-`config.yml` нужно держать в синхроне с `cursor-agent --list-models`.

## References

- [021-fixed-model-cursor-grok-4-6-fast.md](./021-fixed-model-cursor-grok-4-6-fast.md)
