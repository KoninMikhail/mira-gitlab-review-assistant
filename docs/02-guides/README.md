# Гайды для разработчиков

Пошаговые инструкции и runbooks: **как сделать X** в репозитории Mira Review Bot. Для фактов (env, CLI-флаги, поля YAML) — [Справочник](../03-reference/README.md); для «что это и зачем» — [Концепции](../01-concepts/README.md) и [Архитектура](../04-architecture/README.md).

Если вы только подключились к проекту — начните с [Быстрого старта](../00-onboarding/README.md).

---

## Содержание

| Гайд | Когда читать |
| --- | --- |
| [Запуск PoC-ревью одного MR](./run-review-poc.md) | Ручная проверка связки GitLab → Kaiten → Cursor на конкретном MR без poller/worker |
| [Настройка политики проектов](./configure-project-policy.md) | Какие репозитории ревьюить, строгость, игнор glob'ов, триггеры `review_on` |
| [Локальная разработка](./local-development.md) | Dev loop: проверки, тесты с фейками, `npm run dev` / `start:ts`, размещение кода в гексагоне |
| [Ускорение и масштабирование](./performance-scaling.md) | Опц. Redis-очередь, Postgres-стор, кэш чекаута, TTL-кэш Kaiten — когда упёрлись в один процесс |

---

## Связанные материалы

| Тема | Документ |
| --- | --- |
| Переменные окружения | [environment.md](../03-reference/environment.md) |
| CLI (команды и флаги) | [cli.md](../03-reference/cli.md) |
| Политика (YAML, поля) | [policy-config.md](../03-reference/policy-config.md) |
| Схема находок | [finding-schema.md](../03-reference/finding-schema.md) |
| Пайплайн ревью | [review-pipeline.md](../04-architecture/review-pipeline.md) |
| Развёртывание | [deployment.md](../05-operations/deployment.md) |
