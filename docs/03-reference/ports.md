# Порты (`core`)

Источник: `src/core/ports/index.ts`. Реализации — `src/adapters/*` (связка в `src/entrypoints/main.ts`).

## Сводка: порт → адаптер

| Порт | Реализация (MVP) | Примечание |
| --- | --- | --- |
| `VcsReader` | `GitLabReader` | `src/adapters/vcs/gitlab/reader.ts` |
| `VcsCiReader` | `GitLabCiReader` | `src/adapters/vcs/gitlab/ci-reader.ts` — пайплайны/джобы MR |
| `VcsMrLister` | `GitLabReader` | тот же класс |
| `VcsWriter` | `GitLabWriter` | phase 2; не подключён в `main.ts` MVP |
| `TaskTracker` | `KaitenTracker` | read-only REST |
| `ReviewEngine` | `CliHeadlessEngine` | `cursor-agent` headless |
| `AssistantEngine` | `CliHeadlessEngine` (тот же runtime) | промпт `assistant.v1.md`, free-text |
| `Publisher` | `LogPublisher` | dry-run (лог); `GitLabPublisher` — phase 2 |
| `Queue` | `InProcQueue` | in-process FIFO + dedup |
| `StateStore` | `SqliteStateStore` | SQLite |
| `IgnoreStore` | `SqliteStateStore` | тот же класс |
| `Clock` | inline `{ now: () => new Date() }` | в `main.ts`, без отдельного адаптера |

---

## `VcsReader`

**Назначение:** чтение контекста MR (метаданные + список изменённых файлов; diff — локально из checkout).

```typescript
interface VcsReader {
  getMrContext(projectId: string, mrIid: number): Promise<MrContext>;
}
```

**`MrContext`:**

| Поле | Тип |
| --- | --- |
| `projectId` | `string` |
| `mrIid` | `number` |
| `title` | `string` |
| `description` | `string` |
| `sourceBranch` | `string` |
| `targetBranch` | `string` |
| `headSha` | `string` |
| `changedFiles` | `ChangedFile[]` |

---

## `VcsCiReader`

**Назначение:** описание MR + джобы новейшего пайплайна для SHA (presence / wait).
Классификация required vs `when: manual` — в `core/ci`, не в адаптере.

```typescript
interface VcsCiReader {
  getPresenceSnapshot(projectId: string, mrIid: number, sha: string): Promise<PresenceSnapshot>;
  getJobTrace(projectId: string, jobId: number): Promise<string>;
}
```

**`PresenceSnapshot`:** `description: string`, `jobs: CiJob[]` (`id`, `name`, `status`, `when`, `allowFailure`).
**`getJobTrace`:** сырой лог джоба; усечение — в `core/ci`. Вызывается только при red, не на WAIT.

---

## `VcsMrLister`

**Назначение:** список открытых MR для poller (variant B, без webhooks).

```typescript
interface VcsMrLister {
  listOpenMergeRequests(projectId: string): Promise<MrSummary[]>;
}
```

**`MrSummary`:**

| Поле | Тип |
| --- | --- |
| `projectId` | `string` |
| `mrIid` | `number` |
| `title` | `string` |
| `sourceBranch` | `string` |
| `targetBranch` | `string` |
| `headSha` | `string` |
| `isDraft` | `boolean` |
| `state` | `'opened' \| 'closed' \| 'merged' \| 'locked'` |

---

## `VcsWriter`

**Назначение:** запись в MR (notes, discussions, inline, консультативный Approve,
правка description); idempotency — уровень publisher.

```typescript
interface VcsWriter {
  listNotes(projectId: string, mrIid: number): Promise<MrNote[]>;
  createNote(projectId: string, mrIid: number, body: string): Promise<MrNote>;
  updateNote(projectId: string, mrIid: number, noteId: number, body: string): Promise<MrNote>;
  listDiscussions(projectId: string, mrIid: number): Promise<MrDiscussion[]>;
  getDiscussion(
    projectId: string,
    mrIid: number,
    discussionId: string,
  ): Promise<MrDiscussion>;
  addDiscussionNote(
    projectId: string,
    mrIid: number,
    discussionId: string,
    body: string,
  ): Promise<MrNote>;
  createDiscussion(
    projectId: string,
    mrIid: number,
    body: string,
    position?: InlinePosition,
  ): Promise<MrDiscussion>;
  resolveDiscussion(
    projectId: string,
    mrIid: number,
    discussionId: string,
    resolved: boolean,
  ): Promise<void>;
  approveMr(projectId: string, mrIid: number, sha: string): Promise<void>;
  unapproveMr(projectId: string, mrIid: number): Promise<void>;
  updateMrDescription(projectId: string, mrIid: number, description: string): Promise<void>;
}
```

**Вспомогательные типы:**

```typescript
interface MrNote {
  id: number;
  body: string;
  author?: string;
  system: boolean;
}

interface MrDiscussion {
  id: string;
  notes: MrNote[];
  resolved: boolean;
  individualNote: boolean;
}

interface InlinePosition {
  baseSha: string;
  startSha: string;
  headSha: string;
  newPath: string;
  oldPath?: string;
  newLine?: number;
  oldLine?: number;
}
```

---

## `TaskTracker`

**Назначение:** чтение карточки задачи (Kaiten).

```typescript
interface TaskTracker {
  getCard(cardId: string): Promise<TaskCard>;
}
```

---

## `ReviewEngine`

**Назначение:** один прогон анализа по `ReviewContext` → `ReviewResult`.

```typescript
interface ReviewEngine {
  review(context: ReviewContext): Promise<ReviewResult>;
}
```

---

## `AssistantEngine`

**Назначение:** свободный ответ в MR-диалоге (уточнения к finding/summary или
корневой `@mira`) и генерация нового description при rewrite-description.
Не structured review; без идемпотентности `StateStore` (ADR 017, ADR 018).

```typescript
interface AssistantThreadMessage {
  role: 'mira' | 'user';
  author?: string;
  body: string;
}

interface AssistantRequest {
  kind: 'thread' | 'root' | 'rewrite-description';
  context: ReviewContext;
  thread: AssistantThreadMessage[]; // oldest first
  userMessage: string;
}

interface AssistantEngine {
  reply(request: AssistantRequest): Promise<string>;
}
```

Промпт: `prompts/assistant.v1.md` (русская «она», отдельно от `review.v1.md`).

---

## `Publisher`

**Назначение:** публикация готового ревью (MVP — только structured log).

```typescript
interface PublishInput {
  job: JobKey;
  result: ReviewResult;
}

interface Publisher {
  publish(input: PublishInput): Promise<void>;
}
```

---

## `Queue`

**Назначение:** буфер jobs между trigger и worker; dedup по `JobKey`.

```typescript
interface Queue {
  /** `false` если job с тем же JobKey уже pending */
  enqueue(job: ReviewJob): Promise<boolean>;
  dequeue(): Promise<ReviewJob | undefined>;
  size(): Promise<number>;
}
```

---

## `StateStore`

**Назначение:** durable idempotency по полному `ReviewKey` (SHA + версии prompt/partition).

```typescript
interface ReviewKey extends JobKey {
  promptVersion: string;
  partitionVersion: string;
}

interface StateStore {
  seen(key: ReviewKey): Promise<boolean>;
  record(key: ReviewKey, result: ReviewResult): Promise<void>;
}
```

---

## `IgnoreStore`

**Назначение:** mute findings по fingerprint (`@mira ignore`); ключ `(projectId, mrIid)`.

```typescript
interface IgnoreStore {
  ignore(projectId: string, mrIid: number, fingerprint: string): Promise<void>;
  ignored(projectId: string, mrIid: number): Promise<Set<string>>;
}
```

---

## `Clock`

**Назначение:** wall-clock для тестируемости (enqueue timestamps, metrics).

```typescript
interface Clock {
  now(): Date;
}
```

---

## См. также

- [domain-types.md](./domain-types.md) — `JobKey`, `ReviewJob`, `ReviewContext`, `ReviewResult`, …
- [../04-architecture/overview.md](../04-architecture/overview.md)
