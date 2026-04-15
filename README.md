# Ruflo Server — Docker

Docker-образ для централизованного Ruflo MCP-сервера с PostgreSQL (RuVector).

```
Ruflo MCP (stdio) → supergateway (SSE/HTTP) → порт 3000
                          ↕
                    PostgreSQL + pgvector (RuVector)
```

## Быстрый старт (standalone)

```bash
cp .env.example .env
# Отредактировать .env — сменить POSTGRES_PASSWORD
docker compose up -d
```

Сервер: `http://localhost:3000/sse`

## Встраивание как сервис

Образ `jazzmax/ruflo-server` можно добавить в любой существующий `docker-compose.yml`.

### Вариант A: со своим PostgreSQL (pgvector)

Если в проекте ещё нет PostgreSQL с pgvector:

```yaml
services:
  # ... ваши сервисы ...

  ruflo:
    image: jazzmax/ruflo-server:latest
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
    image: jazzmax/ruflo-server:latest
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
    image: jazzmax/ruflo-server:latest
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
    image: jazzmax/ruflo-server:latest
    ports:
      - "3001:3001"
    environment:
      RUFLO_PORT: 3001
      POSTGRES_HOST: ruflo-db
      POSTGRES_DB: ruflo_alpha
      POSTGRES_USER: ruflo
      POSTGRES_PASSWORD: changeme

  ruflo-team-beta:
    image: jazzmax/ruflo-server:latest
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

**Claude Code CLI:**
```bash
claude mcp add ruflo-team --url http://your-server:3000/sse
```

**Claude Desktop / VS Code / Cursor / JetBrains:**
```json
{
  "mcpServers": {
    "ruflo-team": {
      "url": "http://your-server:3000/sse"
    }
  }
}
```

## Переменные окружения

| Переменная | По умолчанию | Описание |
|-----------|-------------|----------|
| `RUFLO_PORT` | `3000` | Порт SSE-сервера |
| `POSTGRES_HOST` | `localhost` | Хост PostgreSQL |
| `POSTGRES_PORT` | `5432` | Порт PostgreSQL |
| `POSTGRES_DB` | `ruflo` | Имя базы данных |
| `POSTGRES_USER` | `ruflo` | Пользователь |
| `POSTGRES_PASSWORD` | `ruflo` | Пароль (сменить!) |

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
docker build --no-cache -t jazzmax/ruflo-server:latest .
docker push jazzmax/ruflo-server:latest
```

**Обновление внутри контейнера (быстро, не переживёт рестарт):**
```bash
docker exec <ruflo-container> npm install -g ruflo@latest
docker restart <ruflo-container>
```

## Docker Hub

```bash
docker pull jazzmax/ruflo-server:latest
```

## Сборка из исходников

```bash
git clone https://github.com/jazz-max/ruflo-server.git
cd ruflo-server
docker build -t jazzmax/ruflo-server:latest .
docker push jazzmax/ruflo-server:latest
```
