# 015. CI как доп. контекст ревью; повтор при смене исхода

- Статус: Принято (Accepted)
- Дата: 2026-09
- Контекст-ссылки: [014-wait-required-ci-before-review.md](./014-wait-required-ci-before-review.md), [../presence-and-ci-wait.md](../presence-and-ci-wait.md)

## Контекст

ADR 014 ждёт обязательный CI, но ревью одно и то же: агент не видит джобов
и логов. Красный пайплайн — сигнал по этому SHA; зелёный после retry на том
же коммите должен дать второе ревью. Mira по-прежнему не gate.

## Решение

Красный CI — **доп. информация** к полному ревью (diff + Kaiten), не отдельный
режим и не замена code review. В `ReviewContext.ci` кладём исход и усечённые
логи упавших required-джобов. Finding «pipeline failed» запрещён промптом.
Исход CI (`ci.green` / `ci.red` / …) фолдится в `promptVersion` ключа: red→green
на том же SHA — новое ревью. Повторный red — `seen`. Poller не пинит SHA после
red/timeout (`onCiMayChange`).

## Альтернативы

| Вариант | Почему не выбран |
| --- | --- |
| Только разбор пайплайна при red | Пропускает security/требования, пока тесты красные |
| Урезанный code review при red | Тот же риск; автор просил CI как evidence |
| Не переревьюить red→green | Автор так и не получит ревью «что тесты не ловят» |
| Колонка `ci_outcome` в store | Тот же эффект через `promptVersion`, без миграции |

## Последствия

- `VcsCiReader.getJobTrace`; `CiJob.id`; trace только на старте red, не на wait.
- Timeout тоже в ключе и тоже отпускает SHA (CI ещё может стать green).

## References

- [014-wait-required-ci-before-review.md](./014-wait-required-ci-before-review.md)
