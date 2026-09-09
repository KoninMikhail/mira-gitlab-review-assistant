# 014. Ждать обязательный CI перед ревью

- Статус: Принято (Accepted)
- Дата: 2026-09
- Контекст-ссылки: [012-no-gitlab-ci-pipelines.md](./012-no-gitlab-ci-pipelines.md), [../presence-and-ci-wait.md](../presence-and-ci-wait.md), [../review-pipeline.md](../review-pipeline.md)

## Контекст

Mira отвечает на MR за минуты, но обязательный GitLab CI часто ещё бежит.
Ревью на «сыром» SHA бесполезно: через минуту прилетит новый коммит или тесты
покажут другое. При этом в пайплайнах обычны необязательные `when: manual`
джобы (deploy). Нужен честный ack «вижу MR, жду тесты» и реальное ожидание
**без** превращения Mira в CI-job (ограничение ADR 012).

## Решение

**Читаем** пайплайны MR/SHA (`VcsCiReader`). Классифицируем только джобы без
`when: manual`. Пока обязательные `pending`/`running`/… — публикуем presence
WAIT, **не** чекаутим, **не** пишем `seen`, ре-enqueue через короткий delay.
После зелёного/красного/отсутствия CI (или timeout ~25 мин) — другой пул фраз
и сразу ревью. `@mira review` (`manual`/`chatops`) ожидание обходит.
Красный обязательный CI ревью **не** блокирует.

## Альтернативы

| Вариант | Почему не выбран |
| --- | --- |
| Только шутка, ревью сразу | Врём в комментарии; ревьюим промежуточный SHA |
| Ждать `pipeline.status` как есть | Вечный wait на ручном deploy |
| Ждать зелёного CI | Mira не gate; красные тесты не отменяют code review |
| LLM-генерация фраз | Дорого, непредсказуемо; пул как у `unavailable-review` |

## Последствия

- Новый порт и GitLab-адаптер (read pipelines/jobs).
- Poller `handled` больше не держит SHA навечно во время wait.
- Ack делит summary-нот с ревью; маркер `mira:ack:<sha>:<kind>`.

См. также [015-ci-as-review-context.md](./015-ci-as-review-context.md): исход CI
попадает в ревью и в ключ идемпотентности.

## References

- [../presence-and-ci-wait.md](../presence-and-ci-wait.md)
