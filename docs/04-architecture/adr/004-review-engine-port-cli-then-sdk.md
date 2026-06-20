# 004. Порт `ReviewEngine`: CLI → SDK → Cloud

- Статус: Принято (Accepted)
- Дата: 2026-06
- Контекст-ссылки: [../review-pipeline.md](../review-pipeline.md), [002-typescript-cursor-sdk.md](./002-typescript-cursor-sdk.md), [005-fixed-model-composer-2-5.md](./005-fixed-model-composer-2-5.md)

## Контекст

Главная развилка реализации — **как запускать Cursor** как движок анализа. Три
варианта (CLI headless, SDK local, Cloud agent) с разным балансом скорости старта,
контроля оркестрации и совместимости с self-hosted GitLab в приватной сети. Запуск
через GitLab CI/CD **не рассматривается** — все варианты — процесс на сервере Mira.

## Решение

**Единый порт `ReviewEngine`** с контрактом `review(context) → ReviewResult`. Три
адаптера за одним портом — **гибридная поэтапная стратегия**:

| Фаза | Адаптер | Реализация |
| --- | --- | --- |
| MVP (фаза 1–2) | `CliHeadlessEngine` | `cursor-agent -p --output-format json` |
| Прод (фаза 3) | `SdkLocalEngine` | `@cursor/sdk`, local runtime |
| Масштаб (фаза 4) | `CloudEngine` | Cursor cloud agent — опция для отдельных проектов |

Переключение — **смена адаптера в конфиге**, не переписывание `core/orchestrator`.

Общие правила для всех адаптеров:

- структурный вывод по JSON-схеме находок; невалидный ответ → retry → деградация;
- MCP read (Kaiten, GitLab) — агенту; **публикацию делает Publisher**, не агент;
- таймауты, лимиты diff, декомпозиция по юнитам — на стороне оркестратора.

## Последствия

**Плюсы:**

- MVP быстро доказывает ценность на минимуме кода (CLI);
- прод получает программную оркестрацию (`cancel`, `wait`, многошаговость, различение
  `CursorAgentError` vs `result.status === "error"`);
- cloud — запасной путь масштабирования без смены пайплайна.

**Минусы:**

- CLI: слабее контроль процесса, парсинг JSON «вокруг» subprocess;
- SDK/CLI: код MR уходит в Cursor API (см.
  [011-cursor-api-egress-allowed.md](./011-cursor-api-egress-allowed.md));
- Cloud: self-hosted GitLab во внутренней сети часто недоступен cloud VM; усиленный
  egress — отдельное согласование ИБ.

**Включает:** `src/adapters/engine/cli/` (реализовано), `src/adapters/engine/sdk/`
(заготовка), `src/adapters/engine/cloud/` (заготовка).

## Альтернативы

| Вариант | Почему отклонён |
| --- | --- |
| Только CLI навсегда | Недостаточный контроль оркестрации и observability для прод |
| Сразу SDK без CLI-PoC | Медленнее time-to-value; CLI нужен для ручной отладки и фазы 0 |
| Только Cloud | Плохая совместимость с приватным self-hosted GitLab; усиленный egress |
| Разные порты под CLI/SDK/Cloud | Дублирование контрактов; переключение ломает composition root |
