# Ruflo Server — Docker

Docker-контейнер для развёртывания централизованного Ruflo MCP-сервера с PostgreSQL (RuVector).

## Архитектура

```
Ruflo MCP (stdio) → supergateway (SSE/HTTP) → порт 3000
                          ↕
                    PostgreSQL + pgvector (RuVector)
```

Ruflo MCP работает в stdio-режиме. [supergateway](https://github.com/supercorp-ai/supergateway) оборачивает его в SSE/HTTP, чтобы клиенты могли подключаться по сети.

## Быстрый старт

```bash
cp .env.example .env
# Отредактировать .env — как минимум сменить POSTGRES_PASSWORD
docker compose up -d
```

Сервер будет доступен на `http://localhost:3000/sse`.

## Подключение клиентов

### Claude Code CLI

```bash
claude mcp add ruflo-team --url http://your-server:3000/sse
```

### Claude Desktop / VS Code / Cursor / JetBrains

Конфигурация в соответствующем `settings.json` / `mcp.json`:

```json
{
  "mcpServers": {
    "ruflo-team": {
      "url": "http://your-server:3000/sse"
    }
  }
}
```

## Хранение данных

### Внутренний Docker-том (по умолчанию)

```env
POSTGRES_DATA=ruflo-pgdata
```

Данные хранятся в Docker volume. Удобно для быстрого старта.

### Внешний каталог на хосте

```env
POSTGRES_DATA=/opt/ruflo/data
```

Данные хранятся на хосте. Удобно для бекапов и миграции между серверами.

## Несколько команд

Для каждой команды — свой инстанс на своём порту:

```bash
# Команда Alpha
RUFLO_PORT=3001 POSTGRES_DB=ruflo_alpha docker compose -p ruflo-alpha up -d

# Команда Beta
RUFLO_PORT=3002 POSTGRES_DB=ruflo_beta docker compose -p ruflo-beta up -d
```

Или через отдельные `.env` файлы:

```bash
docker compose --env-file .env.alpha -p ruflo-alpha up -d
docker compose --env-file .env.beta -p ruflo-beta up -d
```

## Бекап и восстановление

```bash
# Бекап
docker exec ruflo-postgres pg_dump -U ruflo ruflo > backup.sql

# Восстановление
cat backup.sql | docker exec -i ruflo-postgres psql -U ruflo ruflo
```

## Переменные окружения

| Переменная | По умолчанию | Описание |
|-----------|-------------|----------|
| `RUFLO_PORT` | `3000` | Порт SSE-сервера |
| `POSTGRES_DB` | `ruflo` | Имя базы данных |
| `POSTGRES_USER` | `ruflo` | Пользователь PostgreSQL |
| `POSTGRES_PASSWORD` | `ruflo` | Пароль (сменить!) |
| `POSTGRES_DATA` | `ruflo-pgdata` | Docker volume или путь на хосте |

## Docker Hub

```bash
docker build -t jazzmax/ruflo-server:latest .
docker push jazzmax/ruflo-server:latest
```

Или использовать готовый образ без сборки — раскомментировать `image:` в `docker-compose.yml` и убрать `build: .`.
