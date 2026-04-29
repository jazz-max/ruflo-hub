# Ruflo Hub — Docker

A central MCP hub for your team: an HTTP wrapper around the Ruflo CLI (250+ tools), shared memory between Claude Code sessions, and a statusline backed by remote data. Active memory is local sql.js; PostgreSQL (pgvector) is an **optional** backup for `ruflo ruvector import/export`.

> 🇷🇺 Russian version: [docs/ru/README.md](docs/ru/README.md)

> **Guides:**
> - [Use cases](docs/use-cases.md) — scenarios for personal / team / multi-team use, pattern transfer between instances
> - [Ruflo usage guide](docs/ruflo-usage-guide.md) — practical distillation of the official README: what hooks do, which MCP tools you actually need, skills, 3-tier routing
> - [Swarm management](docs/swarm-management.md) — swarm operations: concept, lifecycle, ruflo@3.5.x quirks
> - [Multi-project work with ruflo](docs/ruflo-multiproject-guide.md) — knowledge transfer, task coordination, claims, hive-mind

```
Ruflo MCP (stdio) → Express proxy (Streamable HTTP) → port 3000
                          ↕
                    sql.js (/app/.swarm/memory.db)  ← active memory
                          ↕ (optional, manual commands)
                    PostgreSQL + pgvector (RuVector)  ← archive/bridge
```

## Quick start

### With PostgreSQL (full mode)

```bash
cp .env.example .env
# Edit .env — change POSTGRES_PASSWORD
docker compose up -d
```

`.env` must contain the line `COMPOSE_PROFILES=pg` (it's in `.env.example` by default) — this enables the `ruflo-db` service.

### Lean mode (without PostgreSQL)

```bash
cp .env.example .env
# Comment out or remove the COMPOSE_PROFILES=pg line
docker compose up -d
```

Only the ruflo services will start. Memory will be stored in sql.js (`/app/.swarm/memory.db`), persistent via a volume. Downside: `ruflo ruvector import/export` commands are unavailable — for transferring patterns between instances see alternatives in [docs/use-cases.md](docs/use-cases.md).

Server: `http://localhost:3000/mcp`

## Embedding as a service

The `jazzmax/ruflo-hub` image can be added to any existing `docker-compose.yml`.

> ### ⚠ Memory persistence — read this before deploying
>
> The active memory store (`/app/.swarm/memory.db`, sql.js + HNSW) lives **inside the container's filesystem by default**. If you run `docker compose pull && up -d` (or otherwise recreate the container) without a named volume mounted at `/app/.swarm`, **your entire memory is wiped**. PostgreSQL is *not* a substitute — it's an optional archive used only by `ruflo ruvector import/export`.
>
> Always declare the memory volumes **before the first `docker compose up -d`**:
>
> ```yaml
> services:
>   ruflo:
>     # ...
>     volumes:
>       - ruflo-memory:/app/.swarm        # memory.db + WAL + stderr log
>       - ruflo-state:/app/.claude-flow   # config + system_health stubs
>
> volumes:
>   ruflo-pgdata:
>   ruflo-memory:
>   ruflo-state:
> ```
>
> All three examples below already include these volumes. If you are migrating an *existing* deployment that has no volume on `/app/.swarm`, see [Migrating an existing deployment to volumes](#migrating-an-existing-deployment-to-volumes) below — there is a procedure to copy live data into a new volume without losing it.

### Variant A: with your own PostgreSQL (pgvector)

If your project doesn't yet have PostgreSQL with pgvector:

```yaml
services:
  # ... your services ...

  ruflo:
    image: jazzmax/ruflo-hub:latest
    restart: unless-stopped
    ports:
      - "3000:3000"
    environment:
      RUFLO_PORT: 3000
      POSTGRES_HOST: ruflo-db
      POSTGRES_PORT: 5432
      POSTGRES_DB: ruflo
      POSTGRES_USER: ruflo
      POSTGRES_PASSWORD: changeme
    volumes:
      - ruflo-memory:/app/.swarm
      - ruflo-state:/app/.claude-flow
    depends_on:
      ruflo-db:
        condition: service_healthy

  ruflo-db:
    image: pgvector/pgvector:pg17
    restart: unless-stopped
    environment:
      POSTGRES_DB: ruflo
      POSTGRES_USER: ruflo
      POSTGRES_PASSWORD: changeme
    volumes:
      - ruflo-pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ruflo"]
      interval: 5s
      timeout: 3s
      retries: 10

volumes:
  ruflo-pgdata:
  ruflo-memory:
  ruflo-state:
```

### Variant B: connect to an existing PostgreSQL

If PostgreSQL (with pgvector) already exists in the project:

```yaml
services:
  # ... your existing postgres ...
  # postgres:
  #   image: pgvector/pgvector:pg17
  #   ...

  ruflo:
    image: jazzmax/ruflo-hub:latest
    restart: unless-stopped
    ports:
      - "3000:3000"
    environment:
      RUFLO_PORT: 3000
      POSTGRES_HOST: postgres        # name of your PostgreSQL service
      POSTGRES_PORT: 5432
      POSTGRES_DB: ruflo             # a separate database for ruflo
      POSTGRES_USER: ruflo
      POSTGRES_PASSWORD: changeme
    volumes:
      - ruflo-memory:/app/.swarm
      - ruflo-state:/app/.claude-flow
    depends_on:
      postgres:
        condition: service_healthy

volumes:
  ruflo-memory:
  ruflo-state:
```

> PostgreSQL must have the pgvector extension. The `pgvector/pgvector:pg17` image ships with it.
> A plain `postgres:17` without pgvector will not work.

### Variant C: external PostgreSQL (outside Docker)

```yaml
services:
  ruflo:
    image: jazzmax/ruflo-hub:latest
    restart: unless-stopped
    ports:
      - "3000:3000"
    environment:
      RUFLO_PORT: 3000
      POSTGRES_HOST: 192.168.1.100   # IP of your server
      POSTGRES_PORT: 5432
      POSTGRES_DB: ruflo
      POSTGRES_USER: ruflo
      POSTGRES_PASSWORD: changeme
    volumes:
      - ruflo-memory:/app/.swarm
      - ruflo-state:/app/.claude-flow

volumes:
  ruflo-memory:
  ruflo-state:
```

### Healthcheck

The image has a built-in healthcheck. Other services can depend on ruflo:

```yaml
services:
  my-app:
    image: my-app:latest
    depends_on:
      ruflo:
        condition: service_healthy
```

### Multiple teams — multiple instances

```yaml
services:
  ruflo-team-alpha:
    image: jazzmax/ruflo-hub:latest
    ports:
      - "3001:3001"
    environment:
      RUFLO_PORT: 3001
      POSTGRES_HOST: ruflo-db
      POSTGRES_DB: ruflo_alpha
      POSTGRES_USER: ruflo
      POSTGRES_PASSWORD: changeme

  ruflo-team-beta:
    image: jazzmax/ruflo-hub:latest
    ports:
      - "3002:3002"
    environment:
      RUFLO_PORT: 3002
      POSTGRES_HOST: ruflo-db
      POSTGRES_DB: ruflo_beta
      POSTGRES_USER: ruflo
      POSTGRES_PASSWORD: changeme

  ruflo-db:
    image: pgvector/pgvector:pg17
    environment:
      POSTGRES_USER: ruflo
      POSTGRES_PASSWORD: changeme
    volumes:
      - ruflo-pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ruflo"]
      interval: 5s
      timeout: 3s
      retries: 10

volumes:
  ruflo-pgdata:
```

> With a shared PostgreSQL, each instance uses its own database (`ruflo_alpha`, `ruflo_beta`). Databases are created automatically on the first RuVector startup.

## Connecting clients

### Automatic setup (recommended)

A single command from the project root:

```bash
curl "http://your-server:3000/setup?token=YOUR_TOKEN&name=ruflo-team" | bash
```

Or with an explicit project path:

```bash
curl "http://your-server:3000/setup?token=YOUR_TOKEN&name=ruflo-team" | bash -s /path/to/project
```

#### `/setup` parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `token` | — | Bearer token for authorization (the server's `MCP_AUTH_TOKEN` value) |
| `name` | `ruflo` | MCP server name in `.mcp.json` (determines the tool prefix: `mcp__<name>__*`) |
| `skills` | `1` | Install the skills/agents/commands bundle. `0` (`false`/`no`/`off`) disables it |

#### What the script does

1. Downloads hooks from the server (`auto-memory-hook.mjs`, `hook-handler.cjs`, `statusline.cjs`) into `.claude/helpers/`
2. Downloads and unpacks the `skills` + `agents` + `commands` bundle into `.claude/` (existing files are not overwritten — customizations are preserved; disable with `?skills=0`)
3. Creates `.claude-flow/ruflo.json` with the server URL and token (for the memory bridge)
4. Creates or amends `.mcp.json` with the MCP connection and authorization header
5. Creates `.claude/settings.json` with hook configuration (if the file doesn't already exist)
6. Verifies connectivity to the server

#### Examples

```bash
# Minimal (no auth, default name "ruflo")
curl http://192.168.1.100:3000/setup | bash

# With authorization
curl "http://192.168.1.100:3000/setup?token=572fd23e-ae2e-4e3b-9ea5-59e7a84c09a7" | bash

# Custom name per team
curl "http://192.168.1.100:3001/setup?token=TOKEN_A&name=ruflo-alpha" | bash
curl "http://192.168.1.100:3002/setup?token=TOKEN_B&name=ruflo-beta" | bash

# MCP bridge only, no skills/agents (legacy behavior)
curl "http://192.168.1.100:3000/setup?token=TOKEN&skills=0" | bash
```

#### ⚠️ Server on the same machine — use a hostname, not an IP

If ruflo-hub is running **on your laptop/desktop**, don't pin to an IP — it changes when you switch Wi-Fi/VPN. Use your machine's mDNS name (macOS and most Linux distros support `.local` out of the box via Bonjour/Avahi):

```bash
# macOS/Linux — hostname substitution
curl "http://$(hostname):3201/setup?token=TOKEN" | bash

# Explicit:
curl "http://MacBook-Pro-3.local:3201/setup?token=TOKEN" | bash
```

The same rule applies to `.claude-flow/ruflo.json` and `.mcp.json` — prefer storing `http://MacBook-Pro-3.local:3201/mcp` instead of an IP. Then the client keeps working across any network change.

**When `.local` is NOT suitable:**
- Clients outside the local network (another team's VPN, a remote VPS) — `hostname.local` won't resolve for them. You'll need public DNS (`ruflo.mycompany.com`) or a tunnel (Tailscale/Cloudflare Tunnel).
- Corporate networks with restrictive policies — Bonjour/mDNS may be disabled by IT. Check with `ping $(hostname)` from a client machine.

### Updating the bundle in an already-configured project

When new skills/agents/commands appear in the hub (or they get updated in the Docker image), you can update only the bundle — without re-running `/setup`, which would overwrite your configs:

```bash
# Current directory
curl http://your-server:3000/update-bundle | bash

# With an explicit project path
curl http://your-server:3000/update-bundle | bash -s /path/to/project

# Force-overwrite existing files
curl "http://your-server:3000/update-bundle?force=1" | bash
```

By default `tar -xzkf` (the `-k` flag) doesn't touch existing files — it only adds missing ones. With `?force=1` it's a full overwrite. Unlike `/setup`, this endpoint does not create `.claude-flow/ruflo.json`, `.mcp.json`, or `settings.json` — bundle only.

Don't forget to **restart Claude Code** in the project — skills load at SessionStart.

### Manual MCP connection

If you only need MCP without hooks or the memory bridge:

**Claude Code CLI:**
```bash
claude mcp add --transport http \
  -H "Authorization: Bearer YOUR_TOKEN" \
  ruflo-team http://your-server:3000/mcp
```

**Claude Desktop / VS Code / Cursor / JetBrains** (`.mcp.json`):
```json
{
  "mcpServers": {
    "ruflo-team": {
      "type": "http",
      "url": "http://your-server:3000/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_TOKEN"
      }
    }
  }
}
```

> An MCP connection gives you access to 250+ ruflo tools (memory, swarm, agents). Automatic setup via `/setup` additionally adds the **memory bridge** — pattern synchronization between Claude Code sessions.

## API endpoints

| Method | URL | Description |
|--------|-----|-------------|
| POST | `/mcp` | JSON-RPC proxy to ruflo MCP (main endpoint) |
| GET / DELETE | `/mcp` | Returns `405 Method Not Allowed` (MCP is POST-only) |
| GET | `/health` | Server status (`{"status":"ok","tools":257}`) |
| GET | `/stats` | Statusline summary: vectors, namespaces, `dbSizeKB`, swarm state, intelligence score |
| GET | `/setup` | Shell script for automatic project setup |
| GET | `/update-bundle` | Shell script for bundle-only updates (skills+agents+commands) |
| GET | `/bundle.tar.gz` | Tar.gz archive of the bundle (used by `/setup` and `/update-bundle`) |
| GET | `/templates` | List of available templates |
| GET | `/templates/:name` | Download a specific template |
| GET | `/.well-known/oauth-authorization-server` | OAuth discovery stub (returns 404 so clients fall back to no-auth) |
| GET | `/.well-known/oauth-protected-resource` | OAuth discovery stub (returns 404) |
| POST | `/register` | OAuth dynamic-client stub (returns 404) |

### POST /mcp — JSON-RPC

```bash
# Tool invocation
curl -X POST http://your-server:3000/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"memory_store","arguments":{"key":"my-pattern","value":"pattern content","namespace":"my-project"}},"id":1}'

# Memory search
curl -X POST http://your-server:3000/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"memory_search","arguments":{"query":"my search"}},"id":1}'

# List tools
curl -X POST http://your-server:3000/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/list","id":1}'
```

### Authentication

If `MCP_AUTH_TOKEN` is set, all requests to `/mcp` require the header:

```
Authorization: Bearer <token>
```

The `/health`, `/stats`, `/setup`, `/update-bundle`, `/bundle.tar.gz`, `/templates`, and the OAuth discovery stubs are available without authorization.

## Memory Bridge

The bridge automatically synchronizes knowledge between Claude Code sessions and the ruflo server.

```
┌─────────────────────┐         ┌──────────────┐
│   Claude Code       │         │  Ruflo Server │
│                     │  HTTP   │              │
│  SessionStart ──────┼────────→│  memory_list │
│  (import)           │←────────┼  memory_get  │
│                     │         │              │
│  Stop ──────────────┼────────→│  memory_store│
│  (sync)             │         │              │
└─────────────────────┘         └──────────────┘
```

**At session start** (`auto-memory-hook.mjs import`):
- loads project patterns from the namespace named after the project directory
- loads shared patterns (common to all projects)
- emits them into the Claude Code session context

**At stop** (`auto-memory-hook.mjs sync`):
- reads Claude auto-memory files (`~/.claude/projects/.../memory/*.md`)
- pushes feedback and project entries to ruflo-hub
- available in the next session and from other projects

### Manual control

```bash
# Bridge status
node .claude/helpers/auto-memory-hook.mjs status

# Force sync
node .claude/helpers/auto-memory-hook.mjs sync

# Load patterns
node .claude/helpers/auto-memory-hook.mjs import
```

## Templates (templates/)

Files in `templates/` are served via `/templates/:name` and used by the `/setup` script:

| File | Purpose |
|------|---------|
| `auto-memory-hook.mjs` | Memory bridge — HTTP client for ruflo-hub |
| `hook-handler.cjs` | Claude Code hook handler (routing, status, edit tracking) |
| `statusline.cjs` | Statusline generator (git, model, context, cost, swarm) |
| `settings.json` | Template for `.claude/settings.json` with hook configuration |

### Server URL resolution

`auto-memory-hook.mjs` resolves the server URL in this priority order:

1. The `RUFLO_URL` environment variable
2. The `.claude-flow/ruflo.json` file (created by `/setup`)
3. Auto-discovery from a sibling `ruflo-hub/` project
4. Fallback: `http://localhost:3000/mcp`

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `RUFLO_PORT` | `3000` | MCP server port |
| `POSTGRES_HOST` | `localhost` | PostgreSQL host |
| `POSTGRES_PORT` | `5432` | PostgreSQL port |
| `POSTGRES_DB` | `ruflo` | Database name |
| `POSTGRES_USER` | `ruflo` | User |
| `POSTGRES_PASSWORD` | `ruflo` | Password (change it!) |
| `MCP_AUTH_TOKEN` | — | Bearer token for authorization (if empty — no auth) |

## Backup

The active memory lives in `/app/.swarm/memory.db` inside the ruflo container, mounted from the `<service>-memory` volume. **That volume is what you back up — `pg_dump` of the PostgreSQL database is not enough**, because the regular `memory_store` / `memory_search` tools write into sql.js, not into PostgreSQL. The `claude_flow.*` tables in PostgreSQL are used only by the optional `ruflo ruvector import/export` flow and may legitimately be empty.

```bash
# Backup the memory volume (active memory + HNSW indexes)
docker run --rm -v ruflo-server_ruflo-memory:/d -v "$PWD":/b alpine \
  tar czf /b/ruflo-memory.tgz -C /d .

# Restore
docker run --rm -v ruflo-server_ruflo-memory:/d -v "$PWD":/b alpine \
  sh -c "rm -rf /d/* && tar xzf /b/ruflo-memory.tgz -C /d"

# Optional — PostgreSQL dump (only if you actively use ruvector import/export)
docker exec <postgres-container> pg_dump -U ruflo ruflo > backup.sql
cat backup.sql | docker exec -i <postgres-container> psql -U ruflo ruflo
```

### Migrating an existing deployment to volumes

If you deployed ruflo-hub before adding the `ruflo-memory` / `ruflo-state` volumes, your `/app/.swarm/memory.db` lives inside the container's R/W layer and **the next `docker compose up -d` will erase it**. Migrate live data into a named volume *before* recreating the container.

Run this on the host where ruflo-hub lives. Replace `<service>` with your project name (e.g. `ruflo-hub`) — Compose prefixes volume names with it.

```bash
cd /path/to/ruflo-hub
SNAP=/tmp/ruflo-snap-$(date +%s)
mkdir -p $SNAP/swarm $SNAP/claude-flow

# 1. Snapshot live data while the container is still running (small dataset)
docker cp ruflo:/app/.swarm/. $SNAP/swarm/
docker cp ruflo:/app/.claude-flow/. $SNAP/claude-flow/

# 2. Graceful stop so SQLite checkpoints the WAL, then take a final snapshot
docker compose stop ruflo
docker cp ruflo:/app/.swarm/. $SNAP/swarm/
docker cp ruflo:/app/.claude-flow/. $SNAP/claude-flow/

# 3. Create the named volumes and load the snapshot
docker volume create <service>_ruflo-memory
docker volume create <service>_ruflo-state
docker run --rm -v <service>_ruflo-memory:/dst -v $SNAP/swarm:/src alpine \
  sh -c "rm -rf /dst/* && cp -a /src/. /dst/"
docker run --rm -v <service>_ruflo-state:/dst -v $SNAP/claude-flow:/src alpine \
  sh -c "rm -rf /dst/* && cp -a /src/. /dst/"

# 4. Add the volume mappings to docker-compose.yml (see the warning above for the
#    exact YAML), then recreate the container
docker compose up -d ruflo

# 5. Verify
docker inspect ruflo --format '{{range .Mounts}}{{.Type}} {{.Source}} -> {{.Destination}}{{println}}{{end}}'
curl -s http://localhost:3000/health  # state should be "ready"

# 6. Keep $SNAP for a few days as a safety net before deleting
```

## Operational notes

A few things that look broken but are normal — knowing them up front avoids unnecessary "fixes" that can cause data loss:

- **`system_health` may report `score: 20/100, unhealthy`.** The check looks for marker files at default paths (`./.claude-flow/memory/store.json`, `./.claude-flow/config.json`) and ignores the real backend at `/app/.swarm/memory.db`. The entrypoint creates empty marker files on startup so other Claude instances don't suggest "run memory init" — this is cosmetic only. Use `memory_stats` to see real storage.
- **Don't run `ruflo init` or `ruflo memory init` inside the container.** They would create a second store at the default path and split your data between two places. The container is preconfigured; the active store at `/app/.swarm/memory.db` already works.
- **`claude_flow.embeddings` in PostgreSQL is normally empty (0 rows).** That table is for the RuVector backend (1536-dim), but the regular memory tools write 768-dim ONNX embeddings into sql.js. The two backends are independent. PostgreSQL is touched only by `ruflo ruvector import/export`.
- **`memory_bridge_status: not-synced` is fine** if no project under `~/.claude/projects/*/memory/MEMORY.md` exists yet. The bridge has nothing to mirror; direct `memory_store` calls still work.
- **High CPU at idle** comes from background controllers (consolidation, causal graph, nightly learner). They run regardless of whether you've fed them data.

## Updating ruflo

The `ruflo` package is pinned in the image at build time.

**Image rebuild (recommended):**
```bash
# Locally
docker compose build --no-cache
docker compose up -d

# For Docker Hub
docker build --no-cache -t jazzmax/ruflo-hub:latest .
docker push jazzmax/ruflo-hub:latest
```

**Update inside the container (fast, doesn't survive a restart):**
```bash
docker exec <ruflo-container> npm install -g ruflo@latest
docker restart <ruflo-container>
```

## Docker Hub

```bash
docker pull jazzmax/ruflo-hub:latest      # rolling: every push to main
docker pull jazzmax/ruflo-hub:1            # major: latest 1.x.x
docker pull jazzmax/ruflo-hub:1.1          # minor: latest 1.1.x
docker pull jazzmax/ruflo-hub:1.1.0        # exact pin
docker pull jazzmax/ruflo-hub:<git-sha>    # any commit, for trace/rollback
```

Versioned tags are published when you push a `vX.Y.Z` git tag (see Release process). `:latest` only moves on `main` pushes / weekly rebuilds — never on tag pushes — so pinning to `:1`/`:1.1` stays stable through patch releases.

## Release process

Versions follow [SemVer](https://semver.org/). Notable changes are recorded in [`CHANGELOG.md`](CHANGELOG.md).

```bash
# 1. Update CHANGELOG.md and bump package.json version (e.g. 1.1.0 → 1.2.0)
# 2. Commit
git commit -am "chore: release v1.2.0"
git push origin main

# 3. Tag the release commit and push
git tag v1.2.0
git push origin v1.2.0
```

The `v*.*.*` tag triggers GitHub Actions to publish `jazzmax/ruflo-hub:1.2.0`, `:1.2`, `:1`, and `:<sha>` to Docker Hub.

## Build from source

```bash
git clone https://github.com/jazz-max/ruflo-hub.git
cd ruflo-hub
docker build -t jazzmax/ruflo-hub:latest .
docker push jazzmax/ruflo-hub:latest
```
