# Доменные типы

Источник: `src/core/domain/index.ts`. Framework-agnostic; не зависят от GitLab/Kaiten/Cursor.

## Перечисления

| Имя | Значения | Назначение |
| --- | --- | --- |
| `Severity` | `critical` \| `major` \| `minor` | Серьёзность finding (по последствиям игнорирования) |
| `Verdict` | `ok` \| `risks` \| `blockers` | Итоговый вердикт MR |
| `FindingCategory` | `bug` \| `security` \| `perf` \| `requirements` \| `maintainability` \| `style` | Класс finding |
| `Confidence` | `high` \| `medium` \| `low` | Уверенность ревьюера |
| `RequirementStatus` | `met` \| `partial` \| `missing` \| `unknown` | Статус критерия приёмки |
| `TriggerKind` | `open` \| `ready` \| `push` \| `reopen` \| `chatops` \| `poll` \| `manual` | Причина постановки job в очередь |

---

## `JobKey`

Якорь idempotency: один `(project, mr, sha)` не ревьюится повторно автотриггером.
`@mira review` / CLI обходят `seen`.

| Поле | Тип | Описание |
| --- | --- | --- |
| `projectId` | `string` | ID или path GitLab-проекта |
| `mrIid` | `number` | IID merge request |
| `headSha` | `string` | HEAD commit SHA |

---

## `ReviewJob`

```typescript
interface ReviewJob extends JobKey {
  trigger: TriggerKind;
  enqueuedAt: string; // ISO-8601
}
```

---

## `TaskCard`

Карточка Kaiten после нормализации адаптером.

| Поле | Тип | Описание |
| --- | --- | --- |
| `id` | `string` | ID карточки |
| `title` | `string` | Заголовок |
| `description` | `string` | Описание |
| `acceptanceCriteria` | `string[]` | Критерии приёмки (плоский список из чек-листов) |

---

## `ChangedFile`

| Поле | Тип | Описание |
| --- | --- | --- |
| `path` | `string` | Путь в репо |
| `oldPath` | `string?` | Предыдущий путь при rename |
| `isBinary` | `boolean` | Бинарный файл |
| `isNew` | `boolean` | Новый файл |
| `isDeleted` | `boolean` | Удалённый файл |

---

## `ReviewContext`

Вход движка ревью (один MR или unit после декомпозиции).

| Поле | Тип | Описание |
| --- | --- | --- |
| `job` | `JobKey` | Идентичность MR/SHA |
| `title` | `string` | Заголовок MR |
| `description` | `string` | Описание MR |
| `sourceBranch` | `string` | Source branch |
| `targetBranch` | `string` | Target branch |
| `changedFiles` | `ChangedFile[]` | Изменённые файлы |
| `diff` | `string` | Unified diff (`target...source`), из локального checkout |
| `card` | `TaskCard?` | Связанная карточка Kaiten |
| `ci` | `CiContext?` | Исход обязательного CI + упавшие джобы (ADR 015) |

### `CiContext`

| Поле | Тип | Описание |
| --- | --- | --- |
| `status` | `green` \| `red` \| `none` \| `timeout` | Исход required CI |
| `failures` | `CiFailure[]` | Упавшие blocking-джобы (имя, статус, усечённый log) |

---

## `ReviewUnit`

| Поле | Тип | Описание |
| --- | --- | --- |
| `id` | `string` | ID unit после partition |
| `context` | `ReviewContext` | Контекст slice |

---

## `Finding`

| Поле | Тип | Обяз. | Описание |
| --- | --- | --- | --- |
| `severity` | `Severity` | да | Серьёзность |
| `category` | `FindingCategory` | да | Класс |
| `filePath` | `string` | да | Путь от корня репо |
| `message` | `string` | да | Краткая формулировка |
| `lineStart` | `number?` | нет | Первая строка (1-based) |
| `lineEnd` | `number?` | нет | Последняя строка (1-based) |
| `rationale` | `string?` | нет | Почему важно |
| `suggestion` | `string?` | нет | Предложение исправления |
| `confidence` | `Confidence?` | нет | Уверенность |

---

## `RequirementCoverage`

| Поле | Тип | Обяз. | Описание |
| --- | --- | --- | --- |
| `criterion` | `string` | да | Текст критерия |
| `status` | `RequirementStatus` | да | Статус покрытия |
| `evidence` | `string?` | нет | Файл/строка/обоснование |

---

## `ReviewResult`

| Поле | Тип | Обяз. | Описание |
| --- | --- | --- | --- |
| `verdict` | `Verdict` | да | Итог MR |
| `summary` | `string` | да | Обзор для комментария |
| `findings` | `Finding[]` | да | Список находок |
| `requirementsCoverage` | `RequirementCoverage[]?` | нет | Покрытие критериев Kaiten |
| `degradations` | `string[]?` | нет | Пропуски контекста / анализа |

---

## См. также

- [finding-schema.md](./finding-schema.md) — wire JSON → домен
- [ports.md](./ports.md) — `ReviewKey`, порты
- [../01-concepts/domain-glossary.md](../01-concepts/domain-glossary.md)
