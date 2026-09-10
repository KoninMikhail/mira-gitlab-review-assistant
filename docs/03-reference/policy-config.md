# Policy YAML

Файл policy: env `MIRA_POLICY_CONFIG` → путь на диске (в Docker: `/etc/mira/config.yml`). Парсер: `parsePolicyConfig()` / `loadPolicyConfigFile()` (`src/config/policy-config.ts`). Пример: `deploy/config.example.yml`.

Секреты (токены) **не** в YAML — только env.

Если `MIRA_POLICY_CONFIG` не задан: `defaults` из `defaultProjectPolicy`, `projects: {}`, `discovery: { mode: 'explicit', projects: [] }` (poller idle).

## Корневая структура YAML

| Ключ | Обяз. | Тип | Описание |
| --- | --- | --- | --- |
| `defaults` | да | object | Policy по умолчанию для всех проектов |
| `discovery` | да | object | Список pilot-проектов для poller |
| `projects` | нет | map | Per-project overrides (deep merge поверх `defaults`) |

Парсер принимает **snake_case** (основной) и **camelCase** (альтернатива) для вложенных ключей project policy.

---

## `defaults` / `projects.<path>`

Эффективная policy: `resolvePolicy(config, projectPath)` = `defaults` ⊕ `projects[projectPath]` (field-wise merge).

### `review_on`

**Тип:** массив строк **или** объект с boolean-полями.

**Допустимые триггеры:** `open`, `ready`, `push`, `reopen`, `manual`

| Формат | Пример |
| --- | --- |
| массив | `review_on: [open, ready, manual]` |
| объект | `review_on: { open: true, push: false }` |

**Defaults** (`defaultProjectPolicy`):

| Триггер | Default | Домен |
| --- | --- | --- |
| `open` | `true` | `reviewOn.open` |
| `ready` | `true` | `reviewOn.ready` |
| `push` | `false` | `reviewOn.push` |
| `reopen` | `false` | `reviewOn.reopen` |
| `manual` | `true` | `reviewOn.manual` |

Poller учитывает только `open` / `ready` (initial state). `push` / `reopen` — webhook-only (phase 2).

---

### `strictness`

| Значение | Default | Что публикуется |
| --- | --- | --- |
| `strict` | | `critical`, `major`, `minor` |
| `balanced` | да | `critical`, `major`, `minor` (тише `nit` больше нет — шум не эмитится промптом) |
| `lenient` | | только `critical` и `major` |

---

### `ignored_globs`

| Тип | Default |
| --- | --- |
| `string[]` | см. таблицу |

Default globs:

- `**/*.lock`
- `**/package-lock.json`
- `**/dist/**`
- `**/*.min.js`

Передаются в промпт (`{{ignored_globs}}`). Engine также имеет свой `DEFAULT_IGNORED_GLOBS` (шире — lockfiles, `node_modules`, …).

---

### `context_budget`

| Ключ YAML | Тип | Default | Домен |
| --- | --- | --- | --- |
| `max_chunk_tokens` | number > 0 | `60000` | `contextBudget.maxChunkTokens` |
| `estimate` | `bytes` \| `tokenizer` | `bytes` | `contextBudget.estimate` |

Альтернатива camelCase: `maxChunkTokens`.

---

### `decomposition`

| Ключ | Тип | Default |
| --- | --- | --- |
| `mode` | `'single'` (единственное значение MVP) | `single` |

---

### `model`

| Тип | Default |
| --- | --- |
| string (slug модели Cursor) | `cursor-grok-4.6-high-fast` |

---

### `profile`

**Тип:** string (необязательное). Имя стек-профиля → файл `profiles/<name>.md`, тело которого инжектится в промпт ревьюера через `{{profile_guidance}}` (слой B guidance).

| Тип | Default |
| --- | --- |
| string \| (отсутствует) | не задан (общие практики) |

- Поставляемые профили: `python`, `java`, `node`, `frontend`, `go` (директория `profiles/`, env `MIRA_PROFILES_DIR`).
- Если профиль задан, но файла нет → сервис падает на старте (`ProfileError`, fail-fast).
- Идентификатор + хеш содержимого профиля (`<name>@<sha8>`) подмешиваются в `promptVersion` ключа идемпотентности — правка профиля переревьюит затронутые MR.
- Полный справочник — [review-profiles.md](./review-profiles.md).

---

## `discovery`

| Ключ | Обяз. | Тип | Описание |
| --- | --- | --- | --- |
| `mode` | да | `'explicit'` | Единственный режим MVP |
| `projects` | да | `string[]` | GitLab project paths (`group/sub/project`) |

Poller опрашивает только проекты из `discovery.projects`.

---

## `projects` (overrides)

Ключ — path GitLab-проекта. Значение — partial project policy (любое подмножество полей `defaults`).

Merge правила (`mergeProjectPolicy`):

| Поле | Merge |
| --- | --- |
| `reviewOn` | по полям (override перекрывает) |
| `strictness` | override ?? base |
| `ignoredGlobs` | override ?? base (замена массива целиком) |
| `contextBudget` | по полям |
| `decomposition` | по полям |
| `model` | override ?? base |
| `profile` | override ?? base (наследуется из `defaults`, если не задан в проекте) |

---

## Минимальный пример

```yaml
defaults:
  review_on: [open, ready, manual]
  strictness: balanced
  ignored_globs:
    - '**/*.lock'
  context_budget:
    max_chunk_tokens: 60000
    estimate: bytes
  decomposition:
    mode: single
  model: "cursor-grok-4.6-high-fast"

discovery:
  mode: explicit
  projects:
    - group/sub/project-a

projects:
  group/sub/project-a:
    strictness: strict
    profile: python
```

---

## Ошибки

Невалидный YAML / тип / enum → `PolicyConfigError` с путём поля (`config.defaults.review_on[0]: …`).

---

## См. также

- [environment.md](./environment.md) — `MIRA_POLICY_CONFIG`, `MIRA_PROFILES_DIR`
- [review-profiles.md](./review-profiles.md) — стек-профили (слой B guidance)
- [../02-guides/configure-project-policy.md](../02-guides/configure-project-policy.md)
- `deploy/config.example.yml`
