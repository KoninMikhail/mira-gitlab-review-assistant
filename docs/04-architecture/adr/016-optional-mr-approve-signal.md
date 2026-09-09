# 016. Approve бота — консультативный сигнал, не merge gate

- Статус: Принято (Accepted)
- Дата: 2026-09
- Контекст-ссылки: [../../01-concepts/overview.md](../../01-concepts/overview.md),
  [012-no-gitlab-ci-pipelines.md](./012-no-gitlab-ci-pipelines.md)

## Контекст

N2 исключал Approve, чтобы Mira не стала gate. Тимлиду нужен быстрый сигнал
«бот не нашёл блокеров» в UI GitLab, без обязательности для merge.

## Решение

После публикации настоящего ревью (`GitLabPublisher`, не dry-run)
`verdict === 'ok'` → Approve бота на `headSha`; `risks`/`blockers` → снять
**свой** Approve. Presence/unavailable не трогают approvals. Ошибка Approve
не валит комментарии. Mira **не** required approver и **не** merge'ит.

## Альтернативы

| Вариант | Почему не выбран |
| --- | --- |
| Не ставить Approve | Нет сигнала в approval widget |
| Approve и при `risks` | Слабый сигнал; тимлид всё равно должен смотреть risks |
| Required approval rule на бота | Mira стала бы gate — против N2 |
| Emoji вместо Approve | Не видно в списке approvals |

## Последствия

- `VcsWriter.approveMr` / `unapproveMr`; токену — право Approve на пилотах.
- Не добавлять Mira в required approval rules проекта.

## References

- [012-no-gitlab-ci-pipelines.md](./012-no-gitlab-ci-pipelines.md)
