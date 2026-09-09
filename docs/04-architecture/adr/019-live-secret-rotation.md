# 019. Live rotation of integration tokens

- Статус: Принято (Accepted)
- Дата: 2026-09
- Контекст-ссылки: [../../03-reference/environment.md](../../03-reference/environment.md),
  [../../05-operations/security.md](../../05-operations/security.md)

## Контекст

`CURSOR_API_KEY` (и реже GitLab/Kaiten токены) приходится менять, пока Mira уже
крутится. Раньше ключи читались один раз в `loadConfig()` и копировались в
адаптеры — смена `.env` требовала рестарта. Рестарт рвёт очередь и in-flight
ревью.

## Решение

Ротация **без рестарта** через HTTP на том же сервере, что `/healthz`:

- `PUT /admin/secrets` — частичный JSON (`CURSOR_API_KEY`, `GITLAB_TOKEN`,
  `KAITEN_TOKEN`);
- `GET /admin/secrets` — только `set`/`missing`, **не** значения;
- `POST /admin/secrets/reload` — перечитать файл `MIRA_ENV_FILE` (дефолт `.env`).

Живой `SecretRuntime` мутирует in-memory конфиг и токены адаптеров. Cursor-ключ
подхватывается на следующем job (engine создаётся per-review). Успешный PUT
дописывает ключи в `.env`, чтобы пережить рестарт.

Auth: если задан `MIRA_ADMIN_TOKEN` — Bearer / `X-Mira-Admin-Token`; иначе
только loopback (`127.0.0.1` / `::1`). Наружу без токена эндпоинт не открываем.

При старте process читает `.env` (не перезаписывая уже заданные ENV).

## Альтернативы

| Вариант | Почему не выбран |
| --- | --- |
| Watch `.env` | Хрупкий `fs.watch` на Windows; нет явного «применил» |
| SIGHUP | На Windows нет; некуда слать из IDE |
| Только in-memory, без записи в файл | После рестарта ключ снова старый |
| Vault / Docker secrets live mount | Позже; локальный DX это не закрывает |

## Последствия

- GitLab reader/writer/CI делят один `GitLabClient`, чтобы `setToken` попал во все.
- Kaiten `setToken` на том же экземпляре, что в pipeline.
- Пустой `MIRA_ENV_FILE` отключает load/persist (удобно в контейнере без файла).
- Обязательные ключи по-прежнему нужны на старте (`ConfigError`).

## References

- [environment.md](../../03-reference/environment.md)
- [security.md](../../05-operations/security.md)
