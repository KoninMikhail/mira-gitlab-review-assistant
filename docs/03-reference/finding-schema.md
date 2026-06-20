# Схема findings (JSON)

Wire-контракт агента: **snake_case** JSON. Валидация: `schema/findings.schema.json` (JSON Schema draft 2020-12) через `validateFindings()` (`src/core/findings/validateFindings.ts`). Промпт: `prompts/review.v1.md` (`prompt_version: review.v1`).

Агент пишет `./findings.json` в workspace и дублирует тот же JSON в fenced ` ```json ` в stdout.

## Корневой объект

| Поле (wire) | Тип | Обяз. | Домен (camelCase) | Описание |
| --- | --- | --- | --- | --- |
| `verdict` | enum | да | `verdict` | `ok` \| `risks` \| `blockers` |
| `summary` | string, minLength 1 | да | `summary` | Обзор MR |
| `findings` | array | да | `findings` | Находки |
| `requirements_coverage` | array | нет | `requirementsCoverage` | Покрытие критериев Kaiten |
| `degradations` | string[] | нет | `degradations` | Пропущенный контекст |

`additionalProperties: false` — лишние top-level ключи запрещены.

---

## `verdict`

| Значение | Смысл (промпт) |
| --- | --- |
| `ok` | Нет существенных рисков |
| `risks` | Есть проблемы, но не блокирующие merge |
| `blockers` | Нужно исправить до merge |

---

## `requirements_coverage[]`

| Поле (wire) | Тип | Обяз. | Домен | Описание |
| --- | --- | --- | --- | --- |
| `criterion` | string | да | `criterion` | Текст критерия |
| `status` | enum | да | `status` | `met` \| `partial` \| `missing` \| `unknown` |
| `evidence` | string | нет | `evidence` | Обоснование (файл/строка) |

---

## `findings[]`

| Поле (wire) | Тип | Обяз. | Домен | Описание |
| --- | --- | --- | --- | --- |
| `severity` | enum | да | `severity` | см. ниже |
| `category` | enum | да | `category` | см. ниже |
| `file_path` | string | да | `filePath` | Путь от корня репо |
| `message` | string | да | `message` | Формулировка |
| `line_start` | integer ≥1 | нет | `lineStart` | Первая строка |
| `line_end` | integer ≥1 | нет | `lineEnd` | Последняя строка |
| `rationale` | string | нет | `rationale` | Почему важно |
| `suggestion` | string | нет | `suggestion` | Как исправить |
| `confidence` | enum | нет | `confidence` | `high` \| `medium` \| `low` |

---

## Enum: `severity`

| Значение | Промпт |
| --- | --- |
| `blocker` | Prod break / потеря данных / security hole |
| `major` | Вероятный баг / ключевой критерий не выполнен |
| `minor` | Реальная, но некритичная проблема |
| `nit` | Косметика / стиль / FYI |

---

## Enum: `category`

`bug` \| `security` \| `perf` \| `requirements` \| `maintainability` \| `style`

---

## Enum: `confidence`

`high` \| `medium` \| `low` — при низкой уверенности агент должен снизить severity или опустить finding.

---

## Enum: `status` (requirements)

| Значение | Смысл |
| --- | --- |
| `met` | Критерий выполнен |
| `partial` | Частично |
| `missing` | Не реализован |
| `unknown` | Недостаточно данных |

---

## Маппинг wire → домен

Функция `toReviewResult()` / `toFinding()` в `validateFindings.ts`:

| Wire (snake_case) | Домен (camelCase) |
| --- | --- |
| `file_path` | `filePath` |
| `line_start` | `lineStart` |
| `line_end` | `lineEnd` |
| `requirements_coverage` | `requirementsCoverage` |

Остальные поля совпадают по имени.

---

## Извлечение результата (`CliHeadlessEngine`)

1. `./findings.json` в workspace (приоритет)
2. Иначе fenced ` ```json ` из stdout `cursor-agent`
3. `validateFindings()` → `ReviewResult`

При exit code 0 и ошибке валидации — одна повторная попытка.

---

## Пример (wire)

```json
{
  "verdict": "risks",
  "summary": "Краткий обзор MR.",
  "requirements_coverage": [
    { "criterion": "Добавить endpoint X", "status": "met", "evidence": "src/api.ts:42" }
  ],
  "findings": [
    {
      "severity": "major",
      "category": "bug",
      "file_path": "src/handler.ts",
      "line_start": 10,
      "message": "Не обработан null",
      "confidence": "high"
    }
  ],
  "degradations": ["Не удалось прочитать config/prod.yml"]
}
```

---

## См. также

- [domain-types.md](./domain-types.md)
- [../04-architecture/review-pipeline.md](../04-architecture/review-pipeline.md)
