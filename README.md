# Ruflo Hub — Docker

Центральный MCP-хаб для команды: HTTP-обёртка над Ruflo CLI (250+ инструментов), shared memory между сессиями Claude Code, statusline с remote-данными. Активная память — локальный sql.js; PostgreSQL (pgvector) — **опциональный** бэкап для `ruflo ruvector import/export`.

> **Гайды:**
> - [Use cases](docs/use-cases.md) — сценарии для личного/командного/мульти-командного использования, перенос паттернов между инстансами
> - [Ruflo usage guide](docs/ruflo-usage-guide.md) — практическая выжимка из официального README: что делают хуки, какие MCP-tools реально нужны, skills, 3-tier routing
> - [Swarm management](docs/swarm-management.md) — управление роями: концепция, lifecycle, квирки ruflo@3.5.x
> - [Мультипроектная работа с ruflo](docs/ruflo-multiproject-guide.md) — передача знаний, координация задач, claims, hive-mind

```
Ruflo MCP (stdio) → Express proxy (Streamable HTTP) → порт 3000
                          ↕
                    sql.js (/app/.swarm/memory.db)  ← активная память
                          ↕ (опционально, ручные команды)
                    PostgreSQL + pgvector (RuVector)  ← архив/бридж
```

## Быстрый старт

### С PostgreSQL (полный режим)

```bash
cp .env.example .env
# Отредактировать .env — сменить POSTGRES_PASSWORD
docker compose up -d
```

В `.env` должна быть строка `COMPOSE_PROFILES=pg` (есть в `.env.example` по умолчанию) — она включает сервис `ruflo-db`.

### Lean-режим (без PostgreSQL)

```bash
cp .env.example .env
# Закомментировать или удалить строку COMPOSE_PROFILES=pg
docker compose up -d
```

Поднимутся только ruflo-сервисы. Память будет храниться в sql.js (`/app/.swarm/memory.db`), persistent через volume. Минус: недоступны команды `ruflo ruvector import/export` — для переноса паттернов между инстансами см. альтернативы в [docs/use-cases.md](docs/use-cases.md).

Сервер: `http://localhost:3000/mcp`

## Встраивание как сервис

Образ `jazzmax/ruflo-hub` можно добавить в любой существующий `docker-compose.yml`.

### Вариант A: со своим PostgreSQL (pgvector)

Если в проекте ещё нет PostgreSQL с pgvector:

```yaml
services:
  # ... ваши сервисы ...

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
```

### Вариант B: подключиться к существующему PostgreSQL

Если PostgreSQL (с pgvector) уже есть в проекте:

```yaml
services:
  # ... ваш существующий postgres ...
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
      POSTGRES_HOST: postgres        # имя вашего сервиса с PostgreSQL
      POSTGRES_PORT: 5432
      POSTGRES_DB: ruflo             # отдельная БД для ruflo
      POSTGRES_USER: ruflo
      POSTGRES_PASSWORD: changeme
    depends_on:
      postgres:
        condition: service_healthy
```

> PostgreSQL должен иметь расширение pgvector. Образ `pgvector/pgvector:pg17` включает его.
> Обычный `postgres:17` без pgvector — не подойдёт.

### Вариант C: внешний PostgreSQL (не в Docker)

```yaml
services:
  ruflo:
    image: jazzmax/ruflo-hub:latest
    restart: unless-stopped
    ports:
      - "3000:3000"
    environment:
      RUFLO_PORT: 3000
      POSTGRES_HOST: 192.168.1.100   # IP вашего сервера
      POSTGRES_PORT: 5432
      POSTGRES_DB: ruflo
      POSTGRES_USER: ruflo
      POSTGRES_PASSWORD: changeme
```

### Healthcheck

Образ имеет встроенный healthcheck. Другие сервисы могут зависеть от ruflo:

```yaml
services:
  my-app:
    image: my-app:latest
    depends_on:
      ruflo:
        condition: service_healthy
```

### Несколько команд — несколько инстансов

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

> При общем PostgreSQL каждый инстанс использует свою базу (`ruflo_alpha`, `ruflo_beta`). Базы создаются автоматически при первом запуске RuVector.

## Подключение клиентов

### Автоматическая настройка (рекомендуемый)

Одна команда из корня проекта:

```bash
curl "http://your-server:3000/setup?token=YOUR_TOKEN&name=ruflo-team" | bash
```

Или с указанием пути к проекту:

```bash
curl "http://your-server:3000/setup?token=YOUR_TOKEN&name=ruflo-team" | bash -s /path/to/project
```

#### Параметры `/setup`

| Параметр | По умолчанию | Описание |
|----------|-------------|----------|
| `token` | — | Bearer-токен авторизации (значение `MCP_AUTH_TOKEN` сервера) |
| `name` | `ruflo` | Имя MCP-сервера в `.mcp.json` (определяет префикс инструментов: `mcp__<name>__*`) |

#### Что делает скрипт

1. Скачивает хуки с сервера (`auto-memory-hook.mjs`, `hook-handler.cjs`, `statusline.cjs`) в `.claude/helpers/`
2. Создаёт `.claude-flow/ruflo.json` с URL сервера и токеном (для моста памяти)
3. Создаёт или дополняет `.mcp.json` с MCP-подключением и заголовком авторизации
4. Создаёт `.claude/settings.json` с настройками хуков (если файл не существует)
5. Проверяет связь с сервером

#### Примеры

```bash
# Минимальный (без авторизации, имя по умолчанию "ruflo")
curl http://192.168.1.100:3000/setup | bash

# С авторизацией
curl "http://192.168.1.100:3000/setup?token=572fd23e-ae2e-4e3b-9ea5-59e7a84c09a7" | bash

# Кастомное имя для разных команд
curl "http://192.168.1.100:3001/setup?token=TOKEN_A&name=ruflo-alpha" | bash
curl "http://192.168.1.100:3002/setup?token=TOKEN_B&name=ruflo-beta" | bash
```

### Ручное подключение MCP

Если нужно добавить только MCP без хуков и моста памяти:

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

> MCP-подключение даёт доступ к 250+ инструментам ruflo (memory, swarm, agents). Автоматическая настройка через `/setup` дополнительно добавляет **мост памяти** — синхронизацию паттернов между сессиями Claude Code.

## API-эндпоинты

| Метод | URL | Описание |
|-------|-----|----------|
| POST | `/mcp` | JSON-RPC прокси к ruflo MCP (основной эндпоинт) |
| GET | `/health` | Статус сервера (`{"status":"ok","tools":257}`) |
| GET | `/setup` | Shell-скрипт для автоматической настройки проекта |
| GET | `/templates` | Список доступных шаблонов |
| GET | `/templates/:name` | Скачать конкретный шаблон |

### POST /mcp — JSON-RPC

```bash
# Вызов инструмента
curl -X POST http://your-server:3000/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"memory_store","arguments":{"key":"my-pattern","value":"pattern content","namespace":"my-project"}},"id":1}'

# Поиск в памяти
curl -X POST http://your-server:3000/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"memory_search","arguments":{"query":"my search"}},"id":1}'

# Список инструментов
curl -X POST http://your-server:3000/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/list","id":1}'
```

### Аутентификация

Если задан `MCP_AUTH_TOKEN`, все запросы к `/mcp` требуют заголовок:

```
Authorization: Bearer <token>
```

Эндпоинты `/health`, `/setup`, `/templates` доступны без авторизации.

## Мост памяти (Memory Bridge)

Мост автоматически синхронизирует знания между сессиями Claude Code и сервером ruflo.

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

**При старте сессии** (`auto-memory-hook.mjs import`):
- загружает паттерны проекта из namespace = имя директории проекта
- загружает shared-паттерны (общие для всех проектов)
- выводит в контекст сессии Claude Code

**При остановке** (`auto-memory-hook.mjs sync`):
- читает Claude auto-memory файлы (`~/.claude/projects/.../memory/*.md`)
- пушит feedback и project записи в ruflo-hub
- доступно в следующей сессии и из других проектов

### Ручное управление

```bash
# Статус моста
node .claude/helpers/auto-memory-hook.mjs status

# Принудительная синхронизация
node .claude/helpers/auto-memory-hook.mjs sync

# Загрузить паттерны
node .claude/helpers/auto-memory-hook.mjs import
```

## Шаблоны (templates/)

Файлы в `templates/` раздаются через `/templates/:name` и используются скриптом `/setup`:

| Файл | Назначение |
|------|-----------|
| `auto-memory-hook.mjs` | Мост памяти — HTTP-клиент к ruflo-hub |
| `hook-handler.cjs` | Обработчик хуков Claude Code (routing, status, edit tracking) |
| `statusline.cjs` | Генератор статусной строки (git, model, context, cost, swarm) |
| `settings.json` | Шаблон `.claude/settings.json` с настройками хуков |

### Определение URL сервера

`auto-memory-hook.mjs` определяет URL сервера в порядке приоритета:

1. Переменная окружения `RUFLO_URL`
2. Файл `.claude-flow/ruflo.json` (создаётся `/setup`)
3. Авто-обнаружение из соседнего проекта `ruflo-hub/`
4. Fallback: `http://localhost:3000/mcp`

## Переменные окружения

| Переменная | По умолчанию | Описание |
|-----------|-------------|----------|
| `RUFLO_PORT` | `3000` | Порт MCP-сервера |
| `POSTGRES_HOST` | `localhost` | Хост PostgreSQL |
| `POSTGRES_PORT` | `5432` | Порт PostgreSQL |
| `POSTGRES_DB` | `ruflo` | Имя базы данных |
| `POSTGRES_USER` | `ruflo` | Пользователь |
| `POSTGRES_PASSWORD` | `ruflo` | Пароль (сменить!) |
| `MCP_AUTH_TOKEN` | — | Bearer-токен для авторизации (если пуст — без авторизации) |

## Бекап

```bash
# Бекап
docker exec <postgres-container> pg_dump -U ruflo ruflo > backup.sql

# Восстановление
cat backup.sql | docker exec -i <postgres-container> psql -U ruflo ruflo
```

## Обновление ruflo

Пакет `ruflo` зафиксирован в образе на момент сборки.

**Пересборка образа (рекомендуемый):**
```bash
# Локально
docker compose build --no-cache
docker compose up -d

# Для Docker Hub
docker build --no-cache -t jazzmax/ruflo-hub:latest .
docker push jazzmax/ruflo-hub:latest
```

**Обновление внутри контейнера (быстро, не переживёт рестарт):**
```bash
docker exec <ruflo-container> npm install -g ruflo@latest
docker restart <ruflo-container>
```

## Docker Hub

```bash
docker pull jazzmax/ruflo-hub:latest
```

## Сборка из исходников

```bash
git clone https://github.com/jazz-max/ruflo-hub.git
cd ruflo-hub
docker build -t jazzmax/ruflo-hub:latest .
docker push jazzmax/ruflo-hub:latest
```
