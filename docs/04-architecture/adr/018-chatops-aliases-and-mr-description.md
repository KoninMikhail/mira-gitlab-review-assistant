# 018. ChatOps-алиасы ревью и правка description MR

- Статус: Принято (Accepted)
- Дата: 2026-09
- Scope: расширение whitelist ChatOps; `VcsWriter.updateMrDescription`
- Контекст-ссылки: [017-assistant-chat.md](./017-assistant-chat.md),
  [../triggers.md](../triggers.md)

## Контекст

Корневой `@mira` без точного `review` уходил в Q&A: фразы вроде «давай новое ревью»
не ставили `ReviewJob`. Просьба улучшить описание MR давала только черновик в
комментарии — PATCH description был вне scope ADR 017.

## Решение

Роутер **по-прежнему без LLM**. Расширяем детерминированный whitelist:

1. **Review-алиасы** — `@mira ревью` и императив вокруг `ревью`/`review`
   («давай новое ревью») → тот же `{ kind: 'review' }`, что `@mira review`.
   Вопрос «что такое ревью» командой не является.
2. **`rewrite-description`** — глагол правки + описание / «mr сообщение» →
   `AssistantEngine.reply({ kind: 'rewrite-description' })` →
   `VcsWriter.updateMrDescription` → короткий `<!-- mira:reply -->` в том же треде.
   Текст: по карточке Kaiten, если связана; иначе по diff. Title не трогаем.
3. Dry-run (`publishReplies=false`): engine + лог, без PUT/POST.

## Альтернативы

| Вариант | Почему не выбран |
| --- | --- |
| LLM-классификатор intent | Тот же отказ, что в ADR 017 |
| Только черновик в комментарии | Пользователь просит править шапку MR |
| Assistant сам вызывает GitLab | Write остаётся за портом `VcsWriter` |

## Последствия

- `parseChatOps` знает `{ kind: 'rewrite-description' }` и русские review-алиасы.
- `GitLabWriter` — `PUT .../merge_requests/{iid}` `{ description }`.
- `@mira kill` по-прежнему вне scope.

## References

- [017-assistant-chat.md](./017-assistant-chat.md)
- [../triggers.md](../triggers.md)
