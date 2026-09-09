# Настройка политики проектов

Политика определяет: **какие** GitLab-проекты poller отслеживает, **когда** ставить ревью в очередь (`review_on`), **строгость** фильтрации находок, **игнорируемые** пути и параметры контекста/модели. Загружается из YAML-файла; секреты (токены) **не** хранятся в YAML — только в env.

Парсинг: `src/config/policy-config.ts`. Типы и merge: `src/core/policy/`. Пример файла: `deploy/config.example.yml`.

---

## Подключение файла

1. Скопируйте и адаптируйте пример:

```bash
cp deploy/config.example.yml /path/to/mira-config.yml
```

2. Укажите путь через env (читается в `loadPolicy()` — `src/entrypoints/main.ts`):

```bash
export MIRA_POLICY_CONFIG=/path/to/mira-config.yml
```

В Docker (`deploy/docker-compose.yml`) монтируют файл как `/etc/mira/config.yml` и задают `MIRA_POLICY_CONFIG=/etc/mira/config.yml`.

Если `MIRA_POLICY_CONFIG` **не задан**, сервис стартует с `defaultProjectPolicy` и пустым списком pilot-проектов (`discovery.projects: []`) — poller не найдёт MR для ревью (warning в лог).

PoC CLI (`poc`) **не** читает policy YAML — только env из `loadConfig()`.

---

## Структура YAML

Корень документа — объект с тремя секциями (все обязательны при парсинге через `parsePolicyConfig`):

```yaml
defaults:          # политика по умолчанию для всех проектов
  …

discovery:         # какие проекты poller сканирует (MVP: только explicit)
  mode: explicit
  projects: []

projects:          # опционально: пер-проектные overrides
  group/sub/project-a:
    …
```

Ключи в YAML — **snake_case** (`review_on`, `ignored_globs`, `context_budget`, `max_chunk_tokens`). Парсер также принимает camelCase для части полей (`reviewOn`, `ignoredGlobs`, …).

При ошибке валидации — `PolicyConfigError` с путём к полю (например `config.discovery.mode: expected "explicit"`).

---

## Секция `defaults`

Полная `ProjectPolicy` после merge с дефолтами кода (`defaultProjectPolicy` в `src/core/policy/defaults.ts`):

| Поле YAML | Тип | Дефолт в коде | Описание |
| --- | --- | --- | --- |
| `review_on` | массив строк **или** объект с bool | `[open, ready, manual]` | Триггеры: `open`, `ready`, `push`, `reopen`, `manual` |
| `strictness` | `strict` \| `balanced` \| `lenient` | `balanced` | Пороги фильтрации находок в normalize |
| `ignored_globs` | массив строк | lock, `dist/**`, `*.min.js` | Glob'ы для partition/normalize |
| `context_budget.max_chunk_tokens` | число > 0 | `60000` | Бюджет чанка для partition |
| `context_budget.estimate` | `bytes` \| `tokenizer` | `bytes` | Метод оценки размера diff |
| `decomposition.mode` | `single` | `single` | MVP: один review unit на MR |
| `model` | строка | `cursor-grok-4.6[fast=true]` | Модель для `CliHeadlessEngine` в worker |
| `profile` | строка (опц.) | не задан | Стек-профиль `profiles/<name>.md` → `{{profile_guidance}}` в промпт |

`review_on` как массив — список **включённых** триггеров. Как объект — каждый триггер отдельным bool-полем (`open: true`, `push: false`, …).

`push` и `reopen` в примере deployment отмечены как webhook-only (фаза 2); для MVP poller ориентируется на открытые MR и политику `open`/`ready`.

---

## Секция `discovery`

MVP поддерживает **только** явный список проектов:

```yaml
discovery:
  mode: explicit   # обязательно строка "explicit"
  projects:
    - group/sub/project-a
    - group/sub/project-b
```

- `mode` — любое значение кроме `explicit` → ошибка парсера.
- `projects` — массив непустых строк; пути проектов GitLab (как в UI/API).

Poller (`runPoller`) передаёт `policyConfig.discovery.projects` в discovery открытых MR.

---

## Секция `projects` (overrides)

Ключ — путь проекта GitLab (`group/sub/project`). Значение — **частичная** политика; поля deep-merge'ятся с `defaults` через `mergeProjectPolicy()` / `resolvePolicy()` (`src/core/policy/merge.ts`):

- `reviewOn` — по полям (не заменяет целиком, если указан partial).
- `strictness`, `ignoredGlobs`, `model`, `profile` — override целиком, если указаны.
- `contextBudget`, `decomposition` — merge по вложенным полям.
- `profile` наследуется из `defaults`, если не задан в проекте.

Эффективная политика для MR:

```typescript
resolvePolicy(config, projectPath)
// = mergeProjectPolicy(config.defaults, config.projects[projectPath] ?? {})
```

Если проекта нет в `projects` — используется только `defaults`.

---

## Пример конфигурации

Файл `deploy/config.example.yml` (адаптированный для локального pilot):

```yaml
defaults:
  review_on: [open, ready, manual]
  strictness: balanced
  ignored_globs:
    - '**/*.lock'
    - '**/package-lock.json'
    - '**/dist/**'
    - '**/*.min.js'
  context_budget:
    max_chunk_tokens: 60000
    estimate: bytes
  decomposition:
    mode: single
  model: "cursor-grok-4.6[fast=true]"

discovery:
  mode: explicit
  projects:
    - devops/ai-agents/mira-review-bot

projects:
  devops/ai-agents/mira-review-bot:
    strictness: strict
    profile: node     # стек-профиль profiles/node.md (см. review-profiles.md)
```

Запуск сервиса с этим файлом:

```bash
export MIRA_POLICY_CONFIG=./deploy/config.example.yml
npm run start:ts
```

Для `devops/ai-agents/mira-review-bot` effective policy: `strictness: strict`, остальные поля — из `defaults`.

---

## Где политика применяется

| Компонент | Использование |
| --- | --- |
| Poller | `discovery.projects`, `reviewOn` — ставить ли job в очередь |
| Pipeline | `resolvePolicy(projectId)` → partition (ignored_globs), normalize (strictness), engine (model, profile → `{{profile_guidance}}`) |
| PoC CLI | **не использует** YAML policy |

Детали пайплайна — [review-pipeline.md](../04-architecture/review-pipeline.md). Таблица всех полей — [policy-config.md](../03-reference/policy-config.md).

---

## Проверка YAML без запуска сервиса

Парсер чистый — можно вызвать из теста или REPL:

```typescript
import { readFileSync } from 'node:fs';
import { parsePolicyConfig } from './src/config/policy-config.ts';

const config = parsePolicyConfig(readFileSync('deploy/config.example.yml', 'utf8'));
```

При невалидном YAML или полях — `PolicyConfigError`.

---

## Дальше

- Стек-профили (правила ревью по стеку) — [review-profiles.md](../03-reference/review-profiles.md)
- Ручной прогон одного MR — [run-review-poc.md](./run-review-poc.md)
- Развёртывание с mount config — [deployment.md](../05-operations/deployment.md)
- Переменные окружения сервиса — [environment.md](../03-reference/environment.md)
