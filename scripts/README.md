# scripts/ — Ubuntu Server deployment & ops

Bash scripts to bring Mira Review Bot up on a fresh **Ubuntu Server** (24.04+) as a
multi-container Docker Compose stack (Postgres + Redis + `api` + `poller` + scalable
`worker`), and to operate it afterwards.

They are organized by **who runs them**:

| Folder | Run as | Purpose |
| --- | --- | --- |
| [`root/`](#1-rootroot-system-setup) | `root` (sudo) | One-time host setup: Docker, app user, data dirs, optional firewall |
| [`app/`](#2-appapp-user-lifecycle) | app user (`mira`) | Secrets, build image, start/stop the stack |
| [`tools/`](#3-toolsdayto-day-ops) | app user (`mira`) | Day-to-day ops: logs, health, psql/redis, backup/restore, scale, update |
| `lib/common.sh` | — | Shared helpers sourced by every script (logging, guards, `compose` wrapper) |

> All scripts source `scripts/lib/common.sh`, which sets `set -euo pipefail` and the
> conventions below. They are **idempotent** — safe to re-run.

## Conventions (override via environment)

| Variable | Default | Meaning |
| --- | --- | --- |
| `MIRA_APP_USER` | `mira` | OS user that owns/runs the containers |
| `MIRA_BASE` | `/opt/mira` | Host root for all persistent bind mounts |
| `MIRA_WORKERS` | `2` | Number of `worker` replicas (also 1st arg to `up.sh`) |
| `MIRA_YES` | — | Set `=1` to auto-confirm destructive prompts |

Persistent host layout created under `MIRA_BASE`:

```
/opt/mira/
├── data/postgres/   # Postgres data        (postgres:16-alpine)
├── data/redis/      # Redis AOF            (redis:7-alpine)
├── work/            # ephemeral MR checkouts (WORKSPACE_ROOT)
├── cache/mirrors/   # git mirror cache     (MIRA_CHECKOUT=mirror)
├── config/config.yml# review policy        (mounted read-only)
└── backups/         # pg_dump output
```

Compose project lives in [`deploy/docker-compose.prod.yml`](../deploy/docker-compose.prod.yml);
secrets in `deploy/.env` (generated, `chmod 600`, git-ignored).

---

## Quick start

```bash
# ── On the server, as root ──────────────────────────────────────────────
sudo scripts/root/setup.sh            # Docker + app user + data dirs
# optional baseline host hardening (SSH-only): sudo scripts/root/firewall.sh

# ── As the app user (mira) ──────────────────────────────────────────────
sudo -iu mira
git clone <repo-url> ~/mira-review-bot && cd ~/mira-review-bot

scripts/app/gen-secrets.sh            # writes deploy/.env (random PG/Redis pw)
nano deploy/.env                      # fill CURSOR/GITLAB/KAITEN tokens
nano /opt/mira/config/config.yml      # (after first up) set pilot projects

scripts/app/up.sh                     # build + start (default 2 workers)
scripts/tools/health.sh               # verify
```

> Newly added group membership (`docker`) only applies after a fresh login —
> `sudo -iu mira` gives you that.

---

## 1. `root/` — system setup

Run as **root**. `setup.sh` runs the first three in order.

| Script | What it does |
| --- | --- |
| `setup.sh` | Orchestrator: docker → user → dirs, then prints app-user next steps |
| `install-docker.sh` | Installs Docker Engine + Compose plugin from Docker's official apt repo; enables the service |
| `create-app-user.sh` | Creates the `mira` user and adds it to the `docker` group |
| `add-ssh-key.sh` | Installs an SSH public key into `mira`'s `authorized_keys` (file arg / inline / stdin) so you can `ssh mira@server` directly |
| `setup-dirs.sh` | Creates the `MIRA_BASE` directory tree, `chown` to `mira`, `chmod 750` |
| `firewall.sh` | **Optional** baseline host hardening: ufw default-deny inbound + allow SSH. Note: ufw does **not** filter Docker-published ports (Docker bypasses it via the FORWARD/DOCKER chains); our stack publishes nothing externally anyway |

## 2. `app/` — app-user lifecycle

Run as the **`mira`** user from the repo root.

| Script | What it does |
| --- | --- |
| `gen-secrets.sh` | Creates/maintains `deploy/.env`. Generates strong random `POSTGRES_PASSWORD`/`REDIS_PASSWORD`. **Never overwrites** an existing password (rotating after DB init breaks auth). `chmod 600` |
| `build.sh` | Builds the shared `mira-review-bot:latest` image |
| `up.sh [N]` | Preflights required secrets, seeds `config.yml`, then `compose up -d --build --scale worker=N` (default `MIRA_WORKERS` or 2) |
| `down.sh [flags]` | Stops the stack (confirms before `-v`/`--volumes`) |
| `restart.sh [svc]` | Restarts all or a named service |

## 3. `tools/` — day-to-day ops

Run as the **`mira`** user.

| Script | What it does |
| --- | --- |
| `health.sh` | `compose ps` + probes `/healthz` (exit 1 if unhealthy) |
| `logs.sh [svc...]` | Follows logs (`TAIL=N` to change tail length) |
| `psql.sh [args]` | `psql` shell into Postgres (auth handled) |
| `redis-cli.sh [args]` | `redis-cli` into Redis (auth handled) |
| `backup-db.sh` | `pg_dump` → timestamped `.sql.gz` in `backups/` |
| `restore-db.sh <file>` | Restores a dump (destructive; confirms first) |
| `scale-workers.sh <N>` | Scales the `worker` service to N without recreating others |
| `update.sh [N]` | `git pull --ff-only` (if clean) then rebuild + restart via `up.sh` |
| `shell.sh [svc]` | Interactive shell inside a container (default `worker`) |

---

## Topology & scaling

`api`, `poller`, and `worker` share one image; the role is selected per service via
`ROLE`. The stack runs `MIRA_QUEUE=redis` + `MIRA_STORE=postgres` so multiple workers
drain one shared queue and write to one database — scale horizontally with
`scripts/tools/scale-workers.sh N`. Background, sizing, and the MVP-vs-target topology
are documented in [`docs/05-operations/deployment.md`](../docs/05-operations/deployment.md)
and [`docs/02-guides/performance-scaling.md`](../docs/02-guides/performance-scaling.md).

## Security notes

- Postgres and Redis are **not** published to the host — reachable only on the internal
  compose network. Redis requires a password; Postgres uses SCRAM auth.
- The `api` health/webhook port binds to `127.0.0.1:8080` by default
  (`HEALTH_PUBLISH`); put a TLS reverse proxy in front for phase-2 webhooks.
- Secrets live only in `deploy/.env` (`chmod 600`, git-ignored) — never in the policy
  YAML or the image. See [`docs/05-operations/security.md`](../docs/05-operations/security.md).
- `KAITEN_TOKEN` is **read-only** under the current personal token — no writes.

> The single-container MVP (`deploy/docker-compose.yml`, `ROLE=all`, SQLite, in-process
> queue) still exists for low-volume pilots. These scripts target the scaled
> multi-container topology.
