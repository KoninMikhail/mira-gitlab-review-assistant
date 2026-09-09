# Presence: приветствие Mira и ожидание обязательного CI

Документ описывает **предревью-комментарий** Mira: игривый ack в MR, пока
обязательный CI ещё бежит, и другой тон, когда ревью уже стартует. Реализация —
`src/core/presence/`, `src/core/ci/classify.ts`, порт `VcsCiReader`, адаптер
`GitLabCiReader`; развилка в `createReviewPipeline`.

> ADR: [adr/014-wait-required-ci-before-review.md](./adr/014-wait-required-ci-before-review.md),
> [adr/015-ci-as-review-context.md](./adr/015-ci-as-review-context.md).
> Пайплайн ревью — [review-pipeline.md](./review-pipeline.md).
> Mira **не** является job в GitLab CI (ADR 012) — только **читает** статус и логи.

## Когда говорим

Только если ключ живой (иначе остаётся `unavailable-review`) и триггер
**не** `manual` / `chatops` (`@mira review` не ждёт CI).

Порт `VcsCiReader` опционален в pipeline: без него поведение как раньше
(сразу checkout + ревью). В `main.ts` адаптер всегда подключён.

## Дерево

```text
classify CI
  → wait  → WAIT ack → onWaiting → без checkout, без seen
  → settled (green/red/none/timeout)
        → ReviewKey + ci.kind
        → seen? да, red/timeout → onCiMayChange, skip (без нового ack)
        → seen? да, иначе → skip
        → seen? нет → START ack → ревью (+ traces если red)
  → ошибка CI API / manual / нет reader → ревью без ci-тега
```

К любой presence-фразе: нет ссылки/ID **в описании MR** → второй слот
`FORGOT_TASK`. ID в имени ветки **не** отменяет nudge.

## Что такое «обязательный CI»

Джобы пайплайна текущего `headSha` **кроме** `when: manual` (play-кнопки
деплоя и прочий необязательный хвост). Пайплайн в статусе `manual`, если
висит только на таких джобах, для Mira = обязательная часть уже закончилась.

`allow_failure: true` на обычном джобе не красит wait в красный.

Сырой `pipeline.status` **не** используем: иначе вечное «ждём тесты» на
ручном Deploy.

## Публикация

Один summary-нот (`<!-- mira:summary -->`), как у ревью. Presence — тот же
нот с `<!-- mira:ack:<sha>:<kind> -->`. Повтор WAIT на том же SHA **не**
меняет шутку. Смена kind (wait → green) и финальное ревью — `updateNote`.

`StateStore.record` / `seen` пишутся **только** после ревью, не после ack.
Ключ включает исход CI (`promptVersion+ci.red` / `+ci.green` / …): red→green на
том же SHA — новое ревью. Повторный red — skip. После red/timeout poller **не**
держит SHA в `handled` (`onCiMayChange`).

Ре-enqueue: `onWaiting` в composition root (таймер `CI_RETRY_MS` = 30 с) +
снятие SHA из in-memory `handled` poller'а, чтобы тик polling тоже мог
подхватить.

## Контекст для агента

Красный CI — **доп. информация** к полному ревью, не отдельный режим.
`ReviewContext.ci` (исход + усечённые traces упавших required-джобов) попадает
в промпт. Логи читаются **только** при старте red, не на каждом WAIT.
Finding «pipeline failed» промпт запрещает.

## Код

| Что | Где |
| --- | --- |
| Классификация джобов | `src/core/ci/classify.ts` |
| Упавшие джобы / traces | `src/core/ci/failures.ts` |
| Пулы фраз + compose | `src/core/presence/` |
| Порт | `VcsCiReader` в `src/core/ports/index.ts` |
| GitLab | `src/adapters/vcs/gitlab/ci-reader.ts` |
| Развилка | `src/core/orchestrator/pipeline.ts` |
