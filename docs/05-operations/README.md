# Эксплуатация (operations)

Раздел для **продакшен-развёртывания**, безопасности, наблюдаемости и доступа к сервису Mira Review Bot. Целевая среда — выделенный сервер с сетевым доступом к self-hosted GitLab, Kaiten и Cursor API.

**Текущая фаза (0–1):** один Docker-образ, роль `all` (poller + worker + `/healthz`), in-process очередь, SQLite, publisher в режиме **dry-run** (находки только в лог). Webhook-приёмник, публикация в MR и Postgres — **будущие фазы**.

> **Блокер 🔑P2:** сервис-аккаунту GitLab `mira_review_bot` (id=30) не выданы доступы к пилотным репозиториям — живые прогоны и публикация отложены; poller простаивает без проектов в policy.

---

## Содержание

| Документ | О чём |
| --- | --- |
| [deployment.md](./deployment.md) | Топология сервера, Docker-образ, `docker-compose`, `ROLE`, healthz, policy-конфиг, sizing |
| [security.md](./security.md) | Секреты, изоляция, привилегии бота, Kaiten read-only, egress в Cursor API, prompt injection |
| [observability.md](./observability.md) | Структурные логи, redaction, in-memory метрики, аудит, алерты (план) |

---

## Быстрые ссылки

| Тема | Документ |
| --- | --- |
| Первый запуск локально | [00-onboarding](../00-onboarding/README.md) |
| Переменные окружения | [environment.md](../03-reference/environment.md) |
| Policy YAML | [policy-config.md](../03-reference/policy-config.md) |
| CLI PoC | [cli.md](../03-reference/cli.md) |
| Интеграции (GitLab, Kaiten, Cursor) | [integrations-api.md](../03-reference/integrations-api.md) |
| Архитектура и слои | [overview.md](../04-architecture/overview.md) |
| ADR: egress в Cursor API | [011-cursor-api-egress-allowed.md](../04-architecture/adr/011-cursor-api-egress-allowed.md) |
| ADR: Kaiten read-only | [008-kaiten-read-only.md](../04-architecture/adr/008-kaiten-read-only.md) |
| Дорожная карта | [roadmap.md](../01-concepts/roadmap.md) |
| Порядок задач / блокеры | [execution-order.md](../../tasks/execution-order.md) |

---

## Чек-лист перед продом (кратко)

1. Секреты только в ENV / секрет-менеджере — не в VCS и не в `.mira/config.yml` репозиториев.
2. Бот `mira_review_bot` добавлен в пилотные проекты с минимально нужной ролью.
3. `MIRA_POLICY_CONFIG` смонтирован read-only; discovery указывает на реальные пути проектов.
4. Egress ограничен: GitLab, Kaiten, Cursor API.
5. Логи собираются централизованно; проверен redaction секретов и diff.
6. `/healthz` в мониторинге; бэкап тома `/data` (SQLite).

Подробнее — в [security.md](./security.md) и [deployment.md](./deployment.md).
