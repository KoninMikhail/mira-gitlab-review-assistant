# Review profiles (стек-профили)

Профиль — простой **Markdown-файл** `profiles/<name>.md`, описывающий, на что
ревьюеру обращать особое внимание для конкретного стека (`python`, `java`,
`node`, `frontend`, `go`, …). Тело инжектится в промпт ревьюера на месте
плейсхолдера `{{profile_guidance}}`.

Профиль — это **слой B** трёхслойной модели правил ревью (ADR
[013](../04-architecture/adr/013-layered-review-guidance.md)):

| Слой | Что | Где живёт | Кто владеет |
| --- | --- | --- | --- |
| A — базовый промпт | роль ревьюера + универсальные принципы | `prompts/review.v1.md` | платформенная команда |
| **B — стек-профиль** | «на что смотреть в этом стеке» | `profiles/<name>.md` (центрально) | платформа + стек-лиды |
| C — repo-local | специфика конкретного репозитория | `.cursor/rules/*.mdc`, `AGENTS.md` в репо | команда репозитория |

A + B склеивает бот и инжектит в промпт; C движок (`cursor-agent`) читает сам из
чекаута ветки MR. **Repo-local правила (C) приоритетнее профиля (B)** при конфликте
(так указано в промпте).

---

## Где лежат и как выбираются

- Директория: `profiles/` в корне репо бота. Переопределяется env `MIRA_PROFILES_DIR`
  (в Docker удобно монтировать `/etc/mira/profiles`).
- Загрузка: `loadProfiles()` (`src/config/profiles.ts`) при старте читает все `*.md`.
- Выбор: поле `profile` в policy (`defaults` или `projects.<path>`), см.
  [policy-config.md](./policy-config.md). Имя профиля = имя файла без `.md`.
- Наследование: `profile` в `defaults` применяется ко всем проектам; пер-проектный
  `profile` переопределяет дефолт (`resolvePolicy`).

```yaml
defaults:
  profile: node            # глобальный дефолт для всех
projects:
  backend/billing/api:
    profile: python        # переопределение для одного проекта
  frontend/web/shop:
    profile: frontend
```

Если `profile` не задан нигде — в промпт идёт нейтральная заметка («нет
стек-профиля, применяй общие практики для языков из diff»).

---

## Формат файла

Markdown. Необязательный YAML-frontmatter в начале (между `---`) **срезается** при
загрузке и в промпт не попадает — он для людей/будущего авто-детекта:

```markdown
---
profile: python
match_globs: ["**/*.py"]   # зарезервировано для авто-детекта (не используется в MVP)
---

# Python — фокус ревью

- Мутабельные значения по умолчанию в сигнатурах.
- Ресурсы без контекст-менеджера (`with`).
- Широкие `except:` без логирования.
- SQL-инъекции через f-string; `subprocess(shell=True)`.
```

Рекомендации по содержанию:

- Пишите **чеклистами на естественном языке**, а не JSON/правилами с кодом —
  движок это LLM, ему естественнее проза.
- Только **специфика стека**; не дублируйте универсальные принципы из слоя A.
- Коротко и предметно: конкретные классы багов, риски безопасности/производительности.

---

## Идемпотентность (важно)

Переревью завязано на `ReviewKey.promptVersion`. Чтобы правка профиля
**вступала в силу** на неизменном SHA, в `promptVersion` подмешивается отпечаток
профиля:

```
promptVersion = "review.v1"                       # профиль не задан
promptVersion = "review.v1+python@a1b2c3d4"        # profile: python
```

`a1b2c3d4` — первые 8 hex sha-256 от тела профиля (`versionFor()`). Изменили
`profiles/python.md` → отпечаток меняется → бот переревьюит затронутые MR.

> Repo-local правила (слой C) в ключ **не** входят: они версионируются вместе с
> кодом и меняют SHA сами по себе.

---

## Поставляемые профили

| Профиль | Файл | Покрывает |
| --- | --- | --- |
| `python` | `profiles/python.md` | ресурсы/исключения, async, ORM N+1, инъекции, типизация |
| `java` | `profiles/java.md` | NPE/equals, ресурсы/конкурентность, Spring/JPA, инъекции |
| `node` | `profiles/node.md` | async/ошибки, типобезопасность TS, инъекции, надёжность API |
| `frontend` | `profiles/frontend.md` | хуки/состояние, XSS, a11y, производительность, контракт API |
| `go` | `profiles/go.md` | ошибки/ресурсы, горутины/гонки, nil, инъекции |

Добавить свой профиль: положите `profiles/<name>.md` и сошлитесь на него в policy
(`profile: <name>`). Несуществующее имя профиля → ошибка на старте.

---

## Как добавить новый стек

1. Создайте `profiles/<name>.md` (чеклист на естественном языке).
2. Пропишите `profile: <name>` в `defaults` или `projects.<path>` policy YAML.
3. Перезапустите сервис — на старте профиль валидируется (`assertProfilesResolvable`).

---

## Где применяется в коде

| Компонент | Роль |
| --- | --- |
| `src/config/profiles.ts` | загрузка `*.md`, срез frontmatter, отпечаток |
| `src/entrypoints/main.ts` | загрузка + fail-fast валидация, проброс в engine/ключ |
| `src/core/orchestrator/pipeline.ts` | `resolveGuidanceVersion` → суффикс `promptVersion` |
| `src/adapters/engine/cli/cli-headless-engine.ts` | `{{profile_guidance}}` в `renderPrompt` |
| `prompts/review.v1.md` | секция «Stack profile» |

---

## См. также

- [policy-config.md](./policy-config.md) — поле `profile`
- [../02-guides/configure-project-policy.md](../02-guides/configure-project-policy.md)
- [../04-architecture/adr/013-layered-review-guidance.md](../04-architecture/adr/013-layered-review-guidance.md)
- [environment.md](./environment.md) — `MIRA_PROFILES_DIR`
