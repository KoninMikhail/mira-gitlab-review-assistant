# Stack profiles (`profiles/`)

Стек-профили ревью — **слой B** правил Mira. Каждый файл `<name>.md` описывает,
на что ревьюеру обращать особое внимание для конкретного стека. Тело инжектится
в промпт ревьюера на месте `{{profile_guidance}}`.

- Имя профиля = имя файла без `.md` (`python.md` → профиль `python`).
- Опциональный YAML-frontmatter (между `---`) срезается при загрузке — он для
  людей / будущего авто-детекта, в промпт не идёт.
- Выбор профиля — поле `profile` в policy YAML (`defaults` или `projects.<path>`).
- Директория переопределяется env `MIRA_PROFILES_DIR` (дефолт — этот каталог).

Пишите **чеклистами на естественном языке**, только специфику стека (общие
принципы — в `prompts/review.v1.md`). Полный справочник и идемпотентность:
[`docs/03-reference/review-profiles.md`](../docs/03-reference/review-profiles.md).
Решение — ADR [`013`](../docs/04-architecture/adr/013-layered-review-guidance.md).

Поставляются: `python`, `java`, `node`, `frontend`, `go`.
