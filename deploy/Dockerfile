# Mira review bot — single image, role selected at runtime via ROLE (api|worker|poller|all).
# See docs/05-operations/deployment.md §2.
FROM node:24-bookworm-slim

# git for ephemeral MR checkouts; curl/ca-certificates for the Cursor CLI installer.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git curl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Cursor CLI (cursor-agent). Pin/verify against current Cursor docs at build time.
RUN curl -fsSL https://cursor.com/install | bash
ENV PATH="/root/.local/bin:${PATH}"

WORKDIR /app

# Install deps against the lockfile, then compile TS -> dist and drop dev deps.
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# Ensure the entrypoint is executable even if the source checkout lost the +x
# bit (e.g. git mode 100644 on the host or a Windows clone) — ENTRYPOINT uses
# the exec form, which fails with "permission denied" otherwise.
RUN chmod +x deploy/entrypoint.sh \
  && npm run build && npm prune --omit=dev

# Ephemeral workspaces and the SQLite database live on mounted volumes.
ENV WORKSPACE_ROOT=/work \
    MIRA_DB_PATH=/data/mira.db \
    HEALTH_PORT=8080
RUN mkdir -p /work /data

EXPOSE 8080
ENTRYPOINT ["/app/deploy/entrypoint.sh"]
