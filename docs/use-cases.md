# Use Cases — ruflo-hub

Сценарии использования и рекомендуемые конфигурации. Для деталей развёртывания см. [README](../README.md), по управлению роями — [swarm-management](./swarm-management.md), по мультипроектной работе — [ruflo-multiproject-guide](./ruflo-multiproject-guide.md).

> **TL;DR для команд:** основная ценность — п.2 «[Распределённая команда: распространение паттернов](#2-распределённая-команда-распространение-паттернов)». Остальное — вариации под конкретные конфигурации. Swarm и hive-mind обычно **не нужны** — см. [swarm-management.md](./swarm-management.md) когда они применимы.

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

## 2. Распределённая команда: распространение паттернов

> **Это основная ценность ruflo-hub для команд.** Не swarm, не hive-mind — а то, что один разработчик находит решение, а все остальные автоматически получают его в следующей сессии Claude Code.

**Кто:** команда 2-15 разработчиков, каждый в своём git-дереве, sync через push/pull, deploy по очереди.
**Зачем:** накопление коллективного опыта. Паттерны, найденные одним, становятся доступны всем без ручного обмена.

### Как это работает

```
┌─────────────────────────────────────────────────────────────┐
│ Dev A: работает над задачей, Claude натыкается на проблему  │
│                                                              │
│  1. Claude решает задачу, сохраняет observation в            │
│     ~/.claude/projects/<proj>/memory/feedback_utf8.md:       │
│     "Always use UTF-8 BOM when writing CSV for Excel..."     │
│                                                              │
│  2. Stop hook → auto-memory-hook.mjs sync                    │
│     → memory_store в ruflo-hub, namespace="shared"        │
└─────────────────────────────────────────────────────────────┘
                              ↓
                    ┌──────────────────┐
                    │   ruflo-hub   │
                    │   (общий)        │
                    └──────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│ Dev B: на следующий день открывает Claude Code в своём      │
│ проекте, задача совсем не про CSV                            │
│                                                              │
│  1. SessionStart hook → auto-memory-hook.mjs import          │
│     → memory_list(namespace="shared") → получает паттерны    │
│  2. Все shared-паттерны попадают в контекст новой сессии     │
│  3. Когда Dev B через 2 недели столкнётся с CSV — Claude     │
│     уже будет знать про BOM. Dev B не наступит на грабли.    │
└─────────────────────────────────────────────────────────────┘
```

**Ключевой момент:** ни Dev A, ни Dev B не делают **ничего специально**. Всё происходит через хуки Claude Code + мост памяти. Один раз настроил `/setup` — дальше автоматика.

### Конфигурация

Один ruflo-сервер поднят на внутреннем сервере команды (`http://team-server:3000`):

```bash
# На сервере команды — один раз
git clone https://github.com/jazz-max/ruflo-hub && cd ruflo-hub
cp .env.example .env
# В .env: изменить MCP_AUTH_TOKEN на случайный, сменить POSTGRES_PASSWORD
docker compose up -d
```

Каждый разработчик у себя — одна команда на проект:
```bash
cd ~/projects/my-project
curl "http://team-server:3000/setup?token=TOKEN&name=ruflo" | bash
```

### Namespace-гигиена

Договорённость команды:

| Namespace | Что туда пишется | Кто пишет |
|-----------|------------------|-----------|
| `shared` | Паттерны общие для всей команды (best practices, архитектурные решения, подводные камни) | Все, через memory bridge |
| `project-<name>` | Специфика одного проекта (quirks, internal APIs) | Разработчики этого проекта |
| `<developer>-private` | Личные заметки конкретного разработчика | Только он сам |

Важно: у ruflo **нет ACL на уровне namespace** — все с токеном видят всё. Namespace — это фильтр, не приватность. Секреты не хранить ни в каком виде.

### Что реально получает команда

- **Новичок в команде сразу на уровне senior-ов** по знанию проекта. Паттерны из `shared` + `project-*` попадают в его первую же сессию Claude Code.
- **Постмортемы инцидентов** оседают в памяти. Если Dev A пожёг прод неправильной миграцией и написал об этом feedback — Dev B через месяц увидит предупреждение.
- **Архитектурные решения** не растворяются в каналах Slack и Linear. Остаются доступны Claude-у в контексте конкретной работы.
- **Ревью-замечания** автоматически накапливаются. Dev A получает фидбек на PR → Claude запоминает → Dev B делает аналогичный код → Claude сразу предупреждает.

### Что команда НЕ получает (чтобы не было ложных ожиданий)

- **Не real-time**. Паттерн появляется у Dev B в **следующей** сессии Claude Code, не прямо сейчас. Latency — от секунд до часов.
- **Не автоматическая дистилляция**. В базовой настройке паттерны пишутся «как есть». Если в Claude auto-memory Dev A было 20 мелких заметок про одну тему — у Dev B будут те же 20 заметок, не «главное». Продвинутая дистилляция требует включения `hooks_intelligence_*` и ReasoningBank, см. раздел «Advanced: auto-discovery».
- **Не cross-language contextualization**. Если Dev A пишет на Python, а Dev B на Go — паттерны Python попадут в контекст Dev B. Claude сам понимает что применимо, а что нет, но фильтрации по языку на уровне ruflo нет.

### Swarm тут НЕ нужен

Для этого сценария `swarm_init`, `agent_spawn` и прочие координационные функции ruflo **бесполезны**. Распространение паттернов идёт только через memory + memory bridge. Если в вашей команде sequentialный git-workflow — можете вообще забыть про swarm.

Swarm нужен только если один разработчик (в своей сессии) хочет чтобы Claude зарегистрировал агентов в общей БД **для истории** — редкий случай, см. `docs/swarm-management.md`.

### Advanced: auto-discovery паттернов

Базовый мост памяти — ручной (Claude сам решает что запомнить). Ruflo имеет инфраструктуру для **автоматической** дистилляции:

| Механизм | Что делает |
|----------|-----------|
| `hooks_intelligence_trajectory-*` | Записывает траекторию действий Claude (каждый tool call) |
| `hooks_intelligence_learn` | Извлекает обобщённый паттерн из успешных траекторий |
| ReasoningBank (skill `reasoningbank-intelligence`) | Distillation + verdict judgment + experience replay |
| `autopilot_learn/predict` | Continuous learning в фоне |

Это **не включено** в базовом `/setup`. Требует:
1. Добавить хуки PreToolUse/PostToolUse в `.claude/settings.json` с вызовом trajectory-* tools
2. Настроить периодическую consolidation (раз в сутки — cron)
3. Обработка verdict'ов (что считать успехом/провалом)

Для большинства команд **базового memory-bridge достаточно**. Продвинутое — когда паттернов становится тысячи и нужна автоматическая группировка/удаление устаревшего.

### Минусы и что учесть

- Никакого ACL на уровне namespace — всё доступно всем с токеном. Секреты не хранить.
- Токен нужно ротировать (переменная `MCP_AUTH_TOKEN` на сервере + `/setup` у клиентов).
- Пока `auto-memory-hook.mjs` подхватывает только stdlib Claude Code auto-memory формат. Свой произвольный формат заметок через него не пойдёт (надо вручную `memory_store`).

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
- `SessionStart` → `node .claude/helpers/auto-memory-hook.mjs import` — тянет паттерны с ruflo-hub в контекст новой сессии Claude Code.
- `Stop` → `node .claude/helpers/auto-memory-hook.mjs sync` — пушит заметки из `~/.claude/projects/.../memory/*.md` обратно на ruflo-hub.

**Что это даёт:**
- Никакого ручного `memory_store` — Claude Code сам пишет.
- Паттерны, feedback и project-заметки из auto-memory Claude Code автоматически попадают на сервер.
- Shared-паттерны появляются в контексте **каждой** новой сессии.

**Ограничения:**
- Мост синхронизирует только с **одним** сервером (тем что в `.claude-flow/ruflo.json`). Если в `.mcp.json` прописано несколько ruflo — мост по-прежнему говорит только с одним, остальные доступны только через явные MCP-вызовы Claude.

---

## Чего ruflo-hub НЕ делает

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
│ Docker: ruflo-hub (server.mjs + ruflo CLI)     │
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
