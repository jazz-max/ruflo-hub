# Use Cases — ruflo-server

Сценарии использования и рекомендуемые конфигурации. Для деталей развёртывания см. [README](../README.md), для работы с несколькими проектами — [ruflo-multiproject-guide](./ruflo-multiproject-guide.md).

---

## 1. Личный инстанс разработчика

**Кто:** один разработчик на своей машине или буке.
**Зачем:** персональный стор паттернов, работающих подсказок, архитектурных решений через все свои проекты.

**Конфигурация:**
- Один ruflo-сервер на `localhost:3000` (или любой порт)
- MCP_AUTH_TOKEN можно не задавать (локалка)
- Во всех своих проектах — `curl http://localhost:3000/setup | bash`
- Namespace по умолчанию = имя директории проекта

**Пример работы:**
```bash
# В проекте A
cd ~/projects/my-app-a
curl http://localhost:3000/setup | bash

# В проекте B
cd ~/projects/my-app-b
curl http://localhost:3000/setup | bash
```

После этого Claude Code в обоих проектах:
- Видит MCP-инструменты `mcp__ruflo__*` (257 tools)
- На SessionStart автоматически подтягивает свои паттерны и shared-паттерны
- На Stop синхронизирует новые feedback/project-заметки обратно на сервер

**Память сохраняется** в named volume `ruflo-memory` → переживает `docker compose up --build`.

---

## 2. Команда с общим сервером

**Кто:** команда 2-15 разработчиков.
**Зачем:** общий пул паттернов, единый источник «как мы делаем Х», обучение на коллективном опыте.

**Конфигурация:**
- Один ruflo-сервер поднят на внутреннем сервере команды (`http://team-server:3000`)
- `MCP_AUTH_TOKEN` **обязателен** — включает Bearer-авторизацию
- Каждый разработчик в своих проектах делает:
  ```bash
  curl "http://team-server:3000/setup?token=TOKEN&name=ruflo-team" | bash
  ```
- Namespace-гигиена по договорённости:
  - `<project-name>` — паттерны конкретного проекта
  - `shared` — общие для команды
  - `<developer-login>` — приватные заметки отдельного разработчика

**Плюсы:**
- Новичок в команде сразу имеет доступ к коллективной памяти
- Ревью-ошибки, архитектурные решения, подводные камни — доступны всем

**Минусы и что учесть:**
- Никакого ACL на уровне namespace — всё доступно всем с токеном. Секреты не хранить.
- Токен нужно ротировать (переменная `MCP_AUTH_TOKEN` на сервере + `/setup` у клиентов).

---

## 3. Мульти-командная инсталляция (прод)

**Кто:** организация с несколькими независимыми командами.
**Зачем:** каждая команда хочет свой изолированный стор паттернов, но с возможностью выборочно делиться знаниями между командами.

**Конфигурация — вариант A: один сервер, разные инстансы**

Одна машина, несколько ruflo-контейнеров на разных портах (паттерн из `docker-compose.override.yml`):

```yaml
services:
  ruflo-team-alpha:
    build: .
    ports: ["3001:3001"]
    environment:
      RUFLO_PORT: 3001
      POSTGRES_DB: ruflo_alpha
      MCP_AUTH_TOKEN: ${TOKEN_ALPHA}
    volumes:
      - ruflo-alpha-memory:/app/.swarm

  ruflo-team-beta:
    build: .
    ports: ["3002:3002"]
    environment:
      RUFLO_PORT: 3002
      POSTGRES_DB: ruflo_beta
      MCP_AUTH_TOKEN: ${TOKEN_BETA}
    volumes:
      - ruflo-beta-memory:/app/.swarm
```

Разные токены → разные команды не могут читать память друг друга через MCP.

**Конфигурация — вариант B: разные машины**

- Команда А — ruflo на внутреннем сервере в офисе (`http://office-server:3000`)
- Команда Б — ruflo на удалённом VPS (`https://ruflo.example.com`)
- Независимые volumes, независимые токены

**Это рекомендуемый прод-сценарий** — полная изоляция по сети + шифрование (если HTTPS).

---

## 4. Выборочный перенос паттернов между командами

**Кто:** разработчик, работающий одновременно в двух командах.
**Зачем:** перенести конкретный кейс из памяти одной команды в другую — не весь стор, а точечно.

**Конфигурация:**

В `.mcp.json` проекта **принимающей** команды регистрируются **оба** сервера с разными именами:

```json
{
  "mcpServers": {
    "ruflo-source": {
      "type": "http",
      "url": "http://office-server:3000/mcp",
      "headers": { "Authorization": "Bearer TOKEN_A" }
    },
    "ruflo-target": {
      "type": "http",
      "url": "https://ruflo.example.com/mcp",
      "headers": { "Authorization": "Bearer TOKEN_B" }
    }
  }
}
```

Claude Code увидит две группы инструментов:
- `mcp__ruflo-source__memory_*` — читать из команды А
- `mcp__ruflo-target__memory_*` — писать в команду Б

**Пример запроса:**

> Найди в `ruflo-source` паттерн про решение проблемы с кодировкой. Покажи его содержимое. Если подходит — скопируй в `ruflo-target` в namespace `shared`, с metadata `{ imported_from: "team-alpha", imported_at: "<дата>" }`.

Claude последовательно:
1. `mcp__ruflo-source__memory_search({ query: "кодировка" })`
2. Показывает найденное пользователю
3. `mcp__ruflo-source__memory_retrieve({ key: ... })` — полный content
4. `mcp__ruflo-target__memory_store({ key, value, namespace: "shared", metadata })`

**Важно:**
- Пользователь должен **увидеть content до записи** — чтобы не утекли секреты.
- Использовать namespace `shared` или `imported` — чтобы различать своё и полученное.
- В metadata всегда указывать источник и дату — чтобы через полгода понять, актуален ли паттерн.

---

## 5. Массовый перенос / бэкап памяти

**Когда нужно:**
- Миграция на новый сервер
- Регулярный бэкап
- Слияние двух инстансов

**Инструменты:**

**A. JSON-экспорт/импорт (простой):**
```bash
docker exec ruflo-A ruflo memory export --output /tmp/mem.json
docker cp ruflo-A:/tmp/mem.json ./mem.json
docker cp ./mem.json ruflo-B:/tmp/mem.json
docker exec ruflo-B ruflo memory import --input /tmp/mem.json
```

**B. Через PostgreSQL (RuVector):**

Если хочется использовать PG как централизованный стор — при условии что оба инстанса имеют доступ к одной PG-инстанции:
```bash
# A → PG
docker exec ruflo-A ruflo ruvector import --input /app/.swarm/memory.db \
  --database ruflo --user ruflo --host ruflo-db

# PG → B
docker exec ruflo-B ruflo ruvector export --output /app/.swarm/memory.db \
  --database ruflo --user ruflo --host ruflo-db
```

Полезно когда инстансы на одной машине и PG уже поднят в compose.

**C. SQL-дамп:**
```bash
docker exec ruflo-db pg_dump -U ruflo ruflo > backup.sql
```
Для бэкапа PG, если туда ручной `ruvector import` делался.

---

## 6. Мост памяти с Claude Code auto-memory

**Как работает:** `templates/auto-memory-hook.mjs` ставится в проект через `/setup` и подключается как хук в `.claude/settings.json`:
- `SessionStart` → `node .claude/helpers/auto-memory-hook.mjs import` — тянет паттерны с ruflo-server в контекст новой сессии Claude Code.
- `Stop` → `node .claude/helpers/auto-memory-hook.mjs sync` — пушит заметки из `~/.claude/projects/.../memory/*.md` обратно на ruflo-server.

**Что это даёт:**
- Никакого ручного `memory_store` — Claude Code сам пишет.
- Паттерны, feedback и project-заметки из auto-memory Claude Code автоматически попадают на сервер.
- Shared-паттерны появляются в контексте **каждой** новой сессии.

**Ограничения:**
- Мост синхронизирует только с **одним** сервером (тем что в `.claude-flow/ruflo.json`). Если в `.mcp.json` прописано несколько ruflo — мост по-прежнему говорит только с одним, остальные доступны только через явные MCP-вызовы Claude.

---

## Чего ruflo-server НЕ делает

1. **Не хранит память в PostgreSQL активно.** Память живёт в sql.js файле `/app/.swarm/memory.db` внутри контейнера. PG-схема `claude_flow` создаётся на случай ручного `ruvector import/export`, но при `memory_store` туда ничего не пишется. См. [Architecture](#архитектура-памяти) ниже.

2. **Не шардит между инстансами автоматически.** Два ruflo на разных портах — два независимых стора. Общение только через один из способов переноса (см. п.4/п.5).

3. **Не ротирует токены.** Если `MCP_AUTH_TOKEN` скомпрометирован, надо вручную менять на сервере и у всех клиентов (через повторный `/setup`).

4. **Не шифрует контент.** Всё, что попало в `memory_store`, хранится в plain text внутри контейнера + в WAL. Секреты не хранить.

5. **Не даёт ACL на уровне namespace.** Все, у кого есть MCP-доступ к инстансу, видят все namespaces. Если нужна изоляция команд — разные инстансы с разными токенами (п.3).

---

## Архитектура памяти

```
┌───────────────────────────────────────────────────┐
│ Claude Code (у разработчика)                      │
│   ↕ MCP over HTTP (/mcp, Bearer auth)             │
└────────────────────┬──────────────────────────────┘
                     │
┌────────────────────▼──────────────────────────────┐
│ Docker: ruflo-server (server.mjs + ruflo CLI)     │
│                                                   │
│   Express proxy (/mcp, /health, /stats, /setup)   │
│       ↕ stdio                                     │
│   ruflo mcp start                                 │
│       ↕                                           │
│   sql.js (/app/.swarm/memory.db)    ← активная    │
│                                       память      │
└────────────────────┬──────────────────────────────┘
                     │ (только при ручной команде
                     │  ruflo ruvector import/export)
                     ↓
┌───────────────────────────────────────────────────┐
│ Docker: ruflo-db (pgvector/pgvector:pg17)         │
│ Schema claude_flow — бэкап/бридж для mass-migration│
└───────────────────────────────────────────────────┘
```

**Ключевой факт:** PostgreSQL опционален для большинства use cases. Нужен только если:
- Планируется регулярный `ruvector import/export`
- Нужен SQL-доступ к векторам (аналитика, BI)
- Ожидается переход на будущий PG-backend ruflo (в планах upstream, пока не реализовано)

Если не нужно — PG-сервис можно убрать из compose, освободив ~350MB RAM. См. [README → Варианты развёртывания](../README.md).

---

## Чеклист перед продом

- [ ] `MCP_AUTH_TOKEN` задан и не дефолтный
- [ ] `POSTGRES_PASSWORD` не дефолтный (если PG используется)
- [ ] Volume `ruflo-memory` (или кастомный) подключён к `/app/.swarm` — чтобы память пережила пересборку
- [ ] HTTPS / reverse proxy (nginx, traefik) если сервер доступен из интернета
- [ ] Бэкап volume `ruflo-memory` по расписанию (`docker run --rm -v ruflo-memory:/data -v $(pwd):/backup alpine tar czf /backup/mem-$(date +%F).tgz /data`)
- [ ] Клиенты знают правила namespace (см. п.2, п.3)
- [ ] Документирован способ ротации токена
