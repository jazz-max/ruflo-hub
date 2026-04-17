# Ruflo — мультипроектный сценарий для команды разработчиков

## Что такое Ruflo

Ruflo — платформа для оркестрации AI-агентов, работающая через MCP-протокол. Включает семантическую память с векторными эмбеддингами, обучение на паттернах, координацию задач и кросс-проектный поиск знаний.

Данные хранятся локально в `.swarm/memory.db` (sql.js + HNSW-индексы) в корне каждого проекта.

## Архитектура

```
~/.claude/projects/
├── project-a/memory/     ← Claude Code память (markdown)
├── project-b/memory/
├── project-c/memory/
└── ...

Каждый проект → свой .swarm/memory.db (локальный)
                    ↓
        Ruflo объединяет в единую векторную базу
        с семантическим поиском по всем проектам
```

## Ключевые инструменты

### 1. Импорт памяти из всех проектов

```
memory_import_claude (allProjects: true)
```

Подтягивает Claude Code память из всех проектов в единую базу с ONNX-эмбеддингами (all-MiniLM-L6-v2, 384-dim). После этого доступен **семантический поиск** по знаниям из любого проекта:

> «Как мы решали проблему с кодировкой?» → найдёт ответ, даже если решение было в другом проекте

### 2. Namespace-изоляция

`memory_store` поддерживает `namespace` для логического разделения данных:

```
namespace: "project-a"        → знания конкретного проекта
namespace: "project-b"        → другой проект
namespace: "team-backend"     → общие знания backend-команды
namespace: "team-frontend"    → общие знания frontend-команды
namespace: "shared"           → кросс-проектные решения и архитектура
namespace: "conventions"      → общие правила кодирования
```

### 3. Unified Search

```
memory_search_unified (query: "текст запроса")
```

Ищет одновременно по Claude Code памяти и AgentDB по всем namespace. Полезно когда не знаешь, в каком проекте было решение.

### 4. Координация задач

Две системы с разным назначением:

**Tasks** — простой трекер для внутренних агентов ruflo:

| Инструмент | Назначение |
|-----------|-----------|
| `task_create` | Создать задачу (тип, приоритет, теги) |
| `task_assign` | Назначить на внутреннего агента ruflo |
| `task_update / task_complete` | Обновить прогресс / завершить |
| `task_list / task_summary` | Список и сводка по статусам |

**Claims** — координация между людьми и агентами (кто что делает, чтобы не дублировать работу):

| Инструмент | Назначение |
|-----------|-----------|
| `claims_claim` | Застолбить задачу за собой (человек или агент) |
| `claims_handoff` | Передать задачу другому с прогрессом и причиной |
| `claims_mark-stealable / claims_steal` | Пометить как свободную / забрать себе |
| `claims_rebalance` | Перебалансировка нагрузки между агентами |
| `claims_board` | Визуальная доска (канбан по статусам) |

> **Когда что использовать:** Tasks — для одиночной работы и автоматизации через агентов ruflo. Claims — для командной координации, когда несколько человек или Claude Code сессий работают параллельно.
>
> **Важно:** В claims нет отдельной команды «создать задачу». Задача создаётся автоматически при первом `claims_claim` — ты указываешь `issueId` (например, номер из Linear или GitHub), и claims регистрирует захват. Claims — это реестр «кто что взял», а не трекер задач.

| Инструмент | Назначение |
|-----------|-----------|
| `workflow_create / workflow_execute` | Шаблонизация повторяющихся процессов |

### 5. Обучение на паттернах

| Инструмент | Назначение |
|-----------|-----------|
| `hooks_intelligence_pattern-store` | Сохранение паттерна решения |
| `hooks_intelligence_pattern-search` | Поиск похожих паттернов |
| `autopilot_predict` | Предсказание на основе выученных паттернов |
| `guidance_recommend` | Рекомендации по подходу |

Ruflo учится на действиях разработчика: какие команды запускаются, какие ошибки исправляются, какие решения принимаются. Паттерны хранятся с confidence-скорингом и temporal decay (полупериод: 30 дней).

## Примеры организации для команд

### Вариант A: разделение по ролям

```
Команда Backend:
  namespace: "team-backend"
  → ORM-паттерны, миграции, API-контракты

Команда Frontend:
  namespace: "team-frontend"
  → компоненты, стейт-менеджмент, стили

Общее:
  namespace: "shared"
  → архитектурные решения, интеграции
```

### Вариант B: разделение по проектам

```
namespace: "project-{name}"     → контекст каждого проекта
namespace: "conventions"         → общие правила кодирования
namespace: "incidents"           → разборы инцидентов
```

### Вариант C: гибридный

```
namespace: "project-{name}"              → проект
namespace: "team-{role}"                 → команда
namespace: "shared"                      → общее
namespace: "onboarding"                  → для новых сотрудников
```

## Hive-Mind (мультиагентный режим)

Ruflo поддерживает коллективный интеллект — несколько агентов работают параллельно в рамках одной сессии:

```
hive-mind_init (topology: "mesh" | "hierarchical" | "ring" | "star")
hive-mind_spawn (count: N, role: "worker" | "specialist" | "scout")
hive-mind_memory — общая память роя
hive-mind_consensus — достижение консенсуса между агентами
coordination_orchestrate — оркестрация (parallel / sequential / pipeline / broadcast)
```

Применение: параллельный анализ кода, распределённый код-ревью, одновременная работа над несколькими модулями.

## Централизованный сервер для команды

Локальный режим (`.swarm/` на каждой машине) ограничивает ruflo рамками одного разработчика. Централизованный MCP-сервер снимает это ограничение.

### Архитектура

```
┌─────────────────────────────────────────────────────┐
│  Выделенный сервер (ruflo-hub)                   │
│                                                     │
│  Ruflo MCP (stdio) → supergateway (SSE/HTTP)        │
│  ├── RuVector → PostgreSQL     ← общая база знаний  │
│  └── порт 3000                                      │
└───────────────┬─────────────────┬───────────────────┘
                │                 │
        ┌───────┘                 └────────┐
        ▼                                  ▼
  Разработчик A                      Разработчик B
  Claude Code                        Claude Code
  settings.json:                     settings.json:
  ruflo → http://server:3000         ruflo → http://server:3000
```

### Нужен ли серверу доступ к проектам?

**Нет.** Ruflo MCP-сервер — это «мозг» (база знаний + координатор), а не «руки».

```
Ruflo MCP-сервер                        Claude Code (клиент)
─────────────────                        ────────────────────
Хранит память и паттерны                 Читает/пишет файлы проекта
Координирует задачи                      Делает git diff, анализирует код
Ищет по эмбеддингам                      Передаёт данные в ruflo в параметрах
Обучается на паттернах                   Получает рекомендации от ruflo
НЕ читает исходный код проектов          Имеет полный доступ к проекту
```

Все инструменты ruflo получают данные **через параметры запросов** от Claude Code:

- `memory_store(key, value)` — клиент передаёт текст, сервер сохраняет
- `memory_search(query)` — клиент передаёт запрос, сервер ищет по эмбеддингам
- `analyze_diff(...)` — клиент передаёт diff, сервер анализирует
- `task_create(...)` — клиент описывает задачу, сервер координирует

Сервер **не ходит в файловую систему проектов**, не читает исходный код и не обращается к git. Это значит:

- Сервер можно разместить на отдельной машине без исходников
- Не нужно монтировать проекты или давать доступ к репозиториям
- Безопаснее — сервер хранит только абстрактные знания, не код

> **Исключение:** `memory_import_claude` — читает `~/.claude/projects/*/memory/*.md` с локального диска. В централизованном режиме не используется — клиенты пушат знания через `memory_store`.

### Запуск MCP-сервера

> **Важно:** Ruflo MCP работает только в stdio-режиме (v3.5). Для сетевого доступа используется [ruflo-hub](https://github.com/jazz-max/ruflo-hub) — Docker-контейнер с supergateway-прокси, оборачивающим stdio в SSE/HTTP.
>
> В stdio-режиме claims, tasks, hive-mind видны между сессиями **одного проекта**, но **не между проектами** (у каждого проекта свой процесс). Подробности и полная таблица → [Ограничения stdio-режима](#ограничения-stdio-режима-важно).

> **Почему не `--transport http`?** CLI ruflo принимает флаг `--transport http`, но в коде `startHttpServer()` делает `import('@claude-flow/mcp')` — этот пакет **не существует** (не опубликован в npm, это заглушка под будущую функциональность). Запуск упадёт с `Cannot find module '@claude-flow/mcp'`. Единственный рабочий транспорт — stdio. Для сетевого доступа нужен внешний прокси (supergateway), и именно это делает [ruflo-hub](https://github.com/jazz-max/ruflo-hub).

**Способ 1: Docker Compose** (рекомендуемый):

```bash
git clone https://github.com/jazz-max/ruflo-hub.git
cd ruflo-hub
cp .env.example .env
# Отредактировать .env:
#   RUFLO_PORT=3000           — порт сервера
#   POSTGRES_PASSWORD=...     — пароль БД
#   POSTGRES_DATA=ruflo-pgdata — том для данных
docker compose up -d

# Проверить
curl http://localhost:3000/health
```

> **Важно:** Образ `jazzmax/ruflo-hub` **не содержит PostgreSQL** — только Node.js, ruflo, supergateway и postgresql-client. PostgreSQL поднимается отдельным контейнером (`ruflo-db`) через docker-compose.

**Способ 1б: Docker Hub образ** (если PostgreSQL уже есть):

```bash
# PostgreSQL с pgvector должен быть запущен и доступен.
# Обычный postgres:17 без pgvector не подойдёт — нужен pgvector/pgvector:pg17.
docker run -d --name ruflo-personal \
  -p 3000:3000 \
  -e RUFLO_PORT=3000 \
  -e POSTGRES_HOST=192.168.1.100 \
  -e POSTGRES_PORT=5432 \
  -e POSTGRES_DB=ruflo \
  -e POSTGRES_USER=ruflo \
  -e POSTGRES_PASSWORD=mysecret \
  jazzmax/ruflo-hub:latest

# Проверить
curl http://localhost:3000/health
```

> `POSTGRES_HOST` — IP или hostname существующего сервера PostgreSQL. При запуске в Docker-сети можно указать имя контейнера (например, `postgres`). Схема RuVector (`claude_flow`) будет создана автоматически при первом старте.

Параметры `.env`:

| Переменная | По умолчанию | Описание |
|---|---|---|
| `RUFLO_PORT` | `3000` | Порт, на котором слушает supergateway |
| `POSTGRES_HOST` | `ruflo-db` | Хост PostgreSQL (в compose — имя сервиса) |
| `POSTGRES_PORT` | `5432` | Порт PostgreSQL |
| `POSTGRES_DB` | `ruflo` | Имя базы данных |
| `POSTGRES_USER` | `ruflo` | Пользователь БД |
| `POSTGRES_PASSWORD` | `ruflo` | Пароль БД (**обязательно сменить!**) |
| `POSTGRES_DATA` | `ruflo-pgdata` | Docker volume для данных PostgreSQL |

Внутри контейнера:
```
Ruflo MCP (stdio) → supergateway (SSE/HTTP) → порт 3000
                          ↕
                    PostgreSQL + pgvector (RuVector)
```

**Способ 2: ручной запуск** (без Docker, если нужен кастомный сетап):

```bash
npm install -g ruflo@latest pg supergateway

# 1. PostgreSQL с pgvector должен быть установлен и запущен
# 2. Инициализировать RuVector
npx ruflo ruvector init --database ruflo_team --user ruflo_admin --host localhost

# 3. Запустить через supergateway
npx supergateway \
  --stdio "npx ruflo@latest mcp start" \
  --port 3000 \
  --baseUrl "http://0.0.0.0:3000" \
  --ssePath /sse \
  --messagePath /message
```

### Подключение клиентов

Все клиенты подключаются к SSE-эндпоинту. Конфигурация одинаковая для всех IDE.

**Claude Code CLI:**
```bash
claude mcp add ruflo-team --url http://your-server:3000/sse
```

**Claude Desktop** (`~/Library/Application Support/Claude/claude_desktop_config.json`),
**VS Code** (`.vscode/mcp.json`),
**Cursor** (`.cursor/mcp.json`),
**JetBrains** (Settings → Tools → AI Assistant → MCP):

```json
{
  "mcpServers": {
    "ruflo-team": {
      "url": "http://your-server:3000/sse"
    }
  }
}
```

> Для локальной разработки (без централизованного сервера) можно использовать stdio-режим напрямую:
> ```json
> {
>   "mcpServers": {
>     "ruflo": {
>       "command": "npx",
>       "args": ["ruflo@latest", "mcp", "start"]
>     }
>   }
> }
> ```

> Для подключения красивого статус бара в терминале со счетчиками ruflo в папке проекта:
```bash
npx ruflo@latest init --only-claude 
```

### Варианты хранения

| Вариант | Конкурентный доступ | Масштаб | Рекомендация |
|---------|---------------------|---------|--------------|
| SQLite (`.swarm/memory.db`) | Single-writer, блокировки | 1-2 человека | Для одного разработчика |
| PostgreSQL (RuVector) | Полноценный, 52K+ inserts/sec | Команда любого размера | **Для команды** |
| Git (коммит `.swarm/`) | Ручной, конфликты в бинарных файлах | 2-3 человека | Крайний случай |

### RuVector PostgreSQL — почему для команды

RuVector — мост ruflo к PostgreSQL с 77+ SQL-функциями для AI-операций:

- **HNSW/IVF** индексирование для векторного поиска
- **52,000+ inserts/sec** — нет блокировок SQLite
- **39 Attention-механизмов** — Multi-head, Flash, Sparse, Linear
- **15 типов GNN-слоёв** — GCN, GAT, GraphSAGE
- **Self-Learning** — оптимизатор запросов с EWC++
- **Hyperbolic Embeddings** — Poincaré, Lorentz, Klein модели

**Предварительно:** установить PostgreSQL на сервер (apt, brew, Docker — любым способом). RuVector не устанавливает PostgreSQL сам, а инициализирует схему и AI-функции в существующей базе.

```bash
# 1. PostgreSQL уже установлен и запущен
# 2. Создать базу и пользователя (стандартный psql)
createdb ruflo_team
createuser ruflo_admin

# 3. Инициализировать RuVector-схему (77+ AI-функций, HNSW-индексы)
npx ruflo ruvector init --database ruflo_team --user ruflo_admin

# Мониторинг и обслуживание
npx ruflo ruvector status --verbose
npx ruflo ruvector benchmark --iterations 1000
npx ruflo ruvector optimize --analyze
npx ruflo ruvector backup --output ./backup.sql
```

### Организация namespace для команды

```
namespace: "dev:{username}"           → личное пространство разработчика
namespace: "project:{project-name}"   → знания проекта
namespace: "team:{team-name}"         → командные конвенции
namespace: "shared"                   → кросс-проектные решения
namespace: "incidents"                → разборы инцидентов
namespace: "onboarding"               → для новых сотрудников
```

### Как вызывать инструменты ruflo

Ruflo предоставляет 80+ инструментов (например `memory_store`, `claims_board`, `analyze_diff-risk`). Это **MCP-инструменты**, а не bash-команды — их нельзя набрать в терминале напрямую.

**Способ 1: Через Claude Code (основной)**

Просто попросить Claude на человеческом языке:
```
> Покажи доску задач ruflo
> Сохрани в ruflo: решение проблемы с кодировкой — использовать iconv
> Оцени риски моего diff через ruflo
```
Claude сам вызовет нужный MCP-инструмент с правильными параметрами.

**Способ 2: Через ruflo CLI (частичное покрытие)**

Некоторые инструменты имеют CLI-эквиваленты:
```bash
npx ruflo memory store --key "fix" --value "описание решения"
npx ruflo memory retrieve --query "кодировка"
npx ruflo hive-mind status
npx ruflo swarm status
npx ruflo mcp status
npx ruflo mcp health
```
Но не все MCP-инструменты имеют CLI-аналоги. `claims_board`, `analyze_diff-risk`, `hive-mind_memory` — только через MCP (т.е. через Claude).

**Способ 3: Через MCP Inspector (отладка и администрирование)**

Веб-интерфейс для прямого вызова любого MCP-инструмента с параметрами:
```bash
npx @modelcontextprotocol/inspector npx ruflo@latest mcp start
```
Открывает браузер → выбираете инструмент → заполняете параметры → вызываете. Полезно для администратора сервера при отладке и наполнении базы знаний.

---

### Реальные сценарии

**1. Передача знаний**

Разработчик A решил сложную проблему → сохранил паттерн → разработчик B через неделю сталкивается с похожей → `memory_search` находит решение.

Промпты для Claude Code:
```
# Сохранить решение
> Сохрани в ruflo в namespace shared: при параллельных воркерах на одну очередь 
> возникает deadlock, решение — добавить --tries=3 и unique job ID. Теги: queue, deadlock

# Найти решение
> Поищи в ruflo: воркеры блокируют друг друга
```

<details>
<summary>Вызовы инструментов (что Claude выполнит)</summary>

```bash
# Разработчик A: сохраняет решение
memory_store(
  key: "fix-deadlock-queue-workers",
  value: "При параллельных воркерах на одну очередь возникает deadlock. 
          Решение: добавить --tries=3 и unique job ID. 
          См. коммит abc123.",
  namespace: "shared",
  tags: ["queue", "deadlock", "workers"]
)

# Разработчик B: через неделю ищет решение похожей проблемы
memory_search(
  query: "воркеры блокируют друг друга",
  namespace: "shared"
)
# → находит запись fix-deadlock-queue-workers по семантическому сходству
```

</details>

**2. Код-ревью**

Оценка рисков и подбор ревьюеров по git-истории.

Промпты для Claude Code:
```
# Полный анализ
> Проанализируй через ruflo риски моего diff относительно main, 
> подбери ревьюеров и классифицируй тип изменений

# Оценка конкретного файла
> Оцени через ruflo риск изменений в app/Services/PaymentService.php
```

<details>
<summary>Вызовы инструментов (что Claude выполнит)</summary>

```bash
# Оценить риски текущего diff
analyze_diff-risk(ref: "main..feature-branch")
# → возвращает: risk score, затронутые модули, тип изменений

# Кого позвать на ревью (по истории правок затронутых файлов)
analyze_diff-reviewers(ref: "main..feature-branch", limit: 3)
# → возвращает: список разработчиков, кто чаще всего правил эти файлы

# Классификация изменений (фича / баг-фикс / рефакторинг)
analyze_diff-classify(ref: "main..feature-branch")

# Риск конкретного файла
analyze_file-risk(path: "app/Services/PaymentService.php", additions: 50, deletions: 20)
```

</details>

**3. Онбординг**

Новый сотрудник подключает Claude Code к серверу → получает актуальные знания.

Промпты для Claude Code:
```
# Наполнение базы знаний (делает тимлид)
> Сохрани в ruflo namespace onboarding инструкцию по деплою: 
> git push origin main → CI тесты → sail artisan migrate → sail npm run build.
> Откат: git revert + migrate:rollback. Теги: deploy, ci

> Сохрани в ruflo namespace onboarding инструкцию по локальной установке:
> git clone, cp .env.example .env, sail up -d, sail artisan migrate,
> sail npm run dev. Теги: setup, docker

# Поиск новым сотрудником
> Как развернуть проект локально? Поищи в ruflo в onboarding
```

<details>
<summary>Вызовы инструментов (что Claude выполнит)</summary>

```bash
# Админ: заранее наполняет namespace onboarding
memory_store(
  key: "deploy-guide",
  value: "Деплой: git push origin main → CI прогоняет тесты → 
          sail artisan migrate → sail npm run build. 
          Откат: git revert + sail artisan migrate:rollback.",
  namespace: "onboarding",
  tags: ["deploy", "ci"]
)

memory_store(
  key: "local-setup",
  value: "1. git clone ... 2. cp .env.example .env 
          3. sail up -d 4. sail artisan migrate 
          5. sail npm run dev — Vite на порту 5176",
  namespace: "onboarding",
  tags: ["setup", "docker"]
)

# Новый сотрудник: ищет как поднять проект
memory_search(query: "как развернуть проект локально", namespace: "onboarding")
# → находит local-setup

memory_search(query: "как деплоить на прод", namespace: "onboarding")
# → находит deploy-guide
```

</details>

**4. Координация задач**

Несколько разработчиков работают параллельно → claims предотвращает дублирование работы.

Промпты для Claude Code:
```
# Взять задачу
> Заклеймь в ruflo задачу PROJ-42 за мной (Алексей), 
> я буду рефакторить PaymentService

# Что сейчас в работе
> Покажи все активные задачи в ruflo

# Передать задачу
> Передай в ruflo задачу PROJ-42 от меня (Алексей) Борису, 
> готово на 60%, переключаюсь на hotfix

# Доска задач
> Покажи доску задач ruflo
```

<details>
<summary>Вызовы инструментов (что Claude выполнит)</summary>

```bash
# Разработчик A: берёт задачу
claims_claim(
  issueId: "PROJ-42",
  claimant: "human:dev-a:Алексей",
  context: "Рефакторинг PaymentService — выношу в отдельный модуль"
)

# Разработчик B: видит что задача занята
claims_list(status: "active")
# → PROJ-42: claimed by human:dev-a:Алексей

# Разработчик A: передаёт задачу (заболел / переключился)
claims_handoff(
  issueId: "PROJ-42",
  from: "human:dev-a:Алексей",
  to: "human:dev-b:Борис",
  reason: "Переключаюсь на hotfix, модуль готов на 60%",
  progress: 60
)

# Разработчик B: принимает
claims_claim(
  issueId: "PROJ-42",
  claimant: "human:dev-b:Борис",
  context: "Продолжаю рефакторинг с 60%"
)

# Посмотреть доску всех задач
claims_board()
```

</details>

**4б. Задача между сессиями Claude Code (через stealable)**

Сценарий: в одном проекте поставить задачу, в другом — выполнить. Оба проекта подключены к одному ruflo-personal.

Промпты для Claude Code:
```
# Сессия A (проект Alpha): создать и отпустить задачу
> Заклеймь в ruflo-personal задачу update-ruflo-notion-wiki за мной (Иван): 
> обновить статью в Notion WIKI — убраны английские промпты, добавлена 
> секция Tasks vs Claims. Пометь как stealable — выполнять буду в другой сессии

# Сессия B (другой проект): найти и забрать задачу
> Покажи свободные задачи в ruflo-personal

# Сессия B: забрать и выполнить
> Забери задачу update-ruflo-notion-wiki и выполни её
```

<details>
<summary>Вызовы инструментов (что Claude выполнит)</summary>

```bash
# Сессия A: создаём задачу (claim создаёт запись при первом вызове)
claims_claim(
  issueId: "update-ruflo-notion-wiki",
  claimant: "human:ivan:Иван",
  context: "Обновить статью в Notion WIKI по ruflo. Правки: убраны английские 
            промпты, добавлена секция Tasks vs Claims. Инструкции по Notion — 
            в памяти ruflo-personal."
)

# Сессия A: помечаем как свободную для другой сессии
claims_mark-stealable(
  issueId: "update-ruflo-notion-wiki",
  reason: "voluntary",
  context: "Выполнить в сессии с доступом к Notion"
)

# Сессия B: смотрим свободные задачи
claims_stealable()
# → update-ruflo-notion-wiki: stealable (voluntary), контекст правок внутри

# Сессия B: забираем задачу
claims_steal(
  issueId: "update-ruflo-notion-wiki",
  stealer: "human:ivan:Иван"
)
# → статус: active, можно выполнять

# Сессия B: после выполнения — завершаем
claims_status(
  issueId: "update-ruflo-notion-wiki",
  status: "completed",
  note: "Notion WIKI обновлена"
)
```

</details>

**4в. Командная доска задач (через ruflo-hub)**

Сценарий: команда подключена к общему ruflo-hub (HTTP). Тимлид ставит задачу, разработчик забирает. Все видят одну доску.

Промпты для Claude Code:
```
# Тимлид: поставить задачу и пометить как свободную
> Заклеймь в ruflo-team задачу FIX-auth-redirect за меня (Лена): 
> после логина редирект на /dashboard не работает, куки не пробрасываются. 
> Пометь как stealable

# Разработчик: посмотреть свободные задачи
> Покажи свободные задачи в ruflo-team

# Разработчик: забрать задачу
> Забери в ruflo-team задачу FIX-auth-redirect за меня (Алексей)

# Разработчик: обновить прогресс
> Обнови в ruflo-team статус FIX-auth-redirect — прогресс 70%, 
> нашёл причину: SameSite=Strict на куке

# Разработчик: завершить
> Заверши в ruflo-team задачу FIX-auth-redirect — исправлено, PR #87
```

<details>
<summary>Вызовы инструментов (что Claude выполнит)</summary>

```bash
# Тимлид: создаёт задачу и сразу отпускает
claims_claim(
  issueId: "FIX-auth-redirect",
  claimant: "human:lena:Лена",
  context: "После логина редирект на /dashboard не работает, 
            куки не пробрасываются через middleware"
)
claims_mark-stealable(
  issueId: "FIX-auth-redirect",
  reason: "voluntary",
  context: "Нужен кто-то из бекенд-команды"
)

# Разработчик: видит свободные задачи
claims_stealable()
# → FIX-auth-redirect: stealable, контекст про куки внутри

# Разработчик: забирает
claims_steal(
  issueId: "FIX-auth-redirect",
  stealer: "human:alexey:Алексей"
)

# Разработчик: обновляет прогресс
claims_status(
  issueId: "FIX-auth-redirect",
  status: "active",
  progress: 70,
  note: "Причина: SameSite=Strict на куке"
)

# Разработчик: завершает
claims_status(
  issueId: "FIX-auth-redirect",
  status: "completed",
  note: "Исправлено, PR #87"
)
```

</details>

**5. Общий контекст через Hive-Mind**

Общая память для координации параллельной работы.

Промпты для Claude Code:
```
# Записать план
> Запиши в hive-mind ruflo план рефакторинга auth: выносим в отдельный пакет, 
> НЕ трогать middleware до вторника, API-контракт: POST /api/auth/login, 
> POST /api/auth/refresh

# Прочитать план
> Что в hive-mind ruflo по рефакторингу auth?

# Оповещение
> Разошли через ruflo hive-mind всем: мёрж-фриз до 17:00, деплой релиза. 
> Приоритет высокий

# Список всего в общей памяти
> Покажи всё что есть в hive-mind памяти ruflo
```

<details>
<summary>Вызовы инструментов (что Claude выполнит)</summary>

```bash
# Лид: записывает контекст рефакторинга
hive-mind_memory(
  action: "set",
  key: "refactor-auth-plan",
  value: "Выносим auth в отдельный пакет. НЕ трогать middleware до вторника. 
          API-контракт: POST /api/auth/login, POST /api/auth/refresh."
)

# Любой разработчик: читает контекст
hive-mind_memory(action: "get", key: "refactor-auth-plan")

# Оповестить всех агентов
hive-mind_broadcast(
  message: "Мёрж-фриз до 17:00, деплой релиза",
  priority: "high"
)

# Посмотреть все ключи общей памяти
hive-mind_memory(action: "list")
```

</details>

### Удалённый запуск агентов

**Можно ли с одного рабочего места запустить агента на другом?**

Нет. Ruflo-server координирует знания и задачи, но не управляет Claude Code на чужих машинах.

```
Машина Алексея                 Ruflo Server                Машина Бориса
┌────────────────┐            ┌────────────────┐          ┌────────────────┐
│ Claude Code    │─MCP-запрос─│ Память         │─MCP-запр─│ Claude Code    │
│ (свой процесс) │            │ Задачи         │          │ (свой процесс) │
│ читает/пишет   │            │ Координация    │          │ читает/пишет   │
│ СВОИ файлы     │            │                │          │ СВОИ файлы     │
└────────────────┘            └────────────────┘          └────────────────┘
```

- `agent_spawn` создаёт агента **внутри** ruflo-сервера или текущей Claude Code сессии — не на чужой машине
- `claims_handoff` передаёт **метаданные** задачи — Борис должен сам запустить Claude Code и подхватить её
- `hive-mind_broadcast` отправляет сообщение **агентам внутри одного роя** — не в Claude Code другого разработчика

**Что работает:**

| Сценарий | Возможно? | Как |
|----------|-----------|-----|
| Назначить задачу другому разработчику | Да | `claims_claim` / `claims_handoff` |
| Отправить сообщение всем агентам | Да | `hive-mind_broadcast` |
| Общая память между всеми | Да | `memory_store` / `hive-mind_memory` |
| Запустить код на чужой машине | Нет | — |
| Запустить агента на общем сервере | Возможно | Headless Claude Code на сервере |
| Запустить агента в CI | Да | Через webhook → GitHub Actions |
| Ruflo workers | Да, но локально | Фоновые аналитические задачи внутри ruflo |

**Варианты для удалённого выполнения задач:**

**Вариант A: Headless Claude Code на общем сервере**

```
Общий сервер
├── Ruflo MCP Server
├── Claude Code (headless, демон)  ← выполняет задачи
├── Git-репозитории (клоны)
└── Доступ к коду есть локально

Разработчик → назначает задачу → сервер выполняет
```

Все агенты работают на одной машине с кодом. Разработчики отправляют задачи на сервер, а не запускают что-то друг у друга.

**Вариант B: CI/CD пайплайн как исполнитель**

```
Разработчик → создаёт задачу в ruflo → webhook → GitHub Actions / CI →
→ запускает Claude Code в контейнере → результат обратно в ruflo
```

### Ruflo Background Workers (не путать с удалённым запуском)

Ruflo имеет **12 встроенных фоновых воркеров** — это локальные аналитические задачи внутри ruflo-процесса, а не механизм удалённого запуска Claude Code на другой машине.

```bash
# CLI
npx ruflo worker dispatch --trigger audit --context "./src"
npx ruflo worker status

# Промпты для Claude Code
> Запусти ruflo аудит безопасности для ./app/Servlets/
```

| Trigger | Что делает | Время |
|---------|-----------|-------|
| `ultralearn` | Глубокое изучение и синтез знаний | ~60s |
| `optimize` | Профилирование и оптимизация | ~30s |
| `consolidate` | Очистка и дедупликация памяти | ~20s |
| `predict` | Предиктивный прелоад и кеширование | ~15s |
| `audit` | Сканирование уязвимостей | ~45s |
| `map` | Маппинг архитектуры кодовой базы | ~30s |
| `preload` | Прогрев кеша | ~10s |
| `deepdive` | Глубокий анализ кода | ~60s |
| `document` | Автогенерация документации | ~45s |
| `refactor` | Предложения по рефакторингу | ~30s |
| `benchmark` | Бенчмарки производительности | ~60s |
| `testgaps` | Анализ покрытия тестами | ~30s |

Workers работают **внутри ruflo-процесса** — это не LLM-вызовы и не Claude Code сессии. Полезны для автоматизации рутинных проверок, но не заменяют удалённый запуск агентов.

### Что учесть при развёртывании

| Риск | Митигация |
|------|-----------|
| Секреты в памяти | Вызывать `aidefence_has_pii` перед `memory_store` для проверки на PII (email, ключи, токены). Автоматической защиты нет — это ручная проверка. Namespace не ограничивает доступ, любой клиент может читать любой namespace |
| Сетевые задержки | Эмбеддинг-генерация (ONNX) на сервере. Для удалёнщиков — VPN |
| Размер базы | temporal decay (30 дней), TTL, периодический `memory_stats` и `memory cleanup` |
| Администрирование | Назначить ответственного за namespace-структуру и очистку устаревших паттернов |
| Бекапы | `npx ruflo ruvector backup --output ./backup.sql` или стандартный `pg_dump`. Встроенного планировщика нет — настроить через cron |

## Ограничения stdio-режима (ВАЖНО)

> **Критическое ограничение:** В stdio-режиме каждый **проект** получает свой процесс ruflo. Больше половины функционала ruflo хранит состояние **в оперативной памяти процесса** и не расшаривается между проектами.
>
> **Нюанс:** Внутри одного проекта Claude Code **переиспользует** один процесс ruflo для всех сессий (`claude /new`, новый терминал). Поэтому claims, tasks, hive-mind **видны** между сессиями одного проекта, но **не видны** из другого проекта. (Проверено экспериментально, 2026-04-16.)

### Что расшаривается (SQLite → `.swarm/memory.db`)

| Подсистема | Инструменты |
|---|---|
| Память | `memory_store`, `memory_search`, `memory_search_unified` |
| Паттерны | `hooks_intelligence_pattern-store`, `hooks_intelligence_pattern-search` |
| Траектории | `hooks_intelligence_trajectory-*` |
| Сессии | `session_save`, `session_restore` |
| Эмбеддинги | `embeddings_generate`, `embeddings_search` |

Расшаривание работает благодаря обёртке с фиксированным `cwd` → единый файл `~/.ruflo-personal/.swarm/memory.db` (см. секцию «Личный ruflo: общая память между проектами»).

### Что НЕ расшаривается между проектами (in-memory → привязано к процессу)

| Подсистема | Инструменты | Что теряется |
|---|---|---|
| **Claims** | `claims_claim`, `claims_board`, `claims_handoff`... | Доска задач, захваты, передачи |
| **Tasks** | `task_create`, `task_assign`, `task_list`... | Трекер задач и назначения |
| **Hive-Mind** | `hive-mind_init`, `hive-mind_broadcast`, `hive-mind_memory`... | Общая память роя, оповещения |
| **Agents** | `agent_spawn`, `agent_pool`, `agent_list`... | Запущенные агенты и их состояние |
| **Coordination** | `coordination_sync`, `coordination_consensus`... | Топология, балансировка |
| **Swarm** | `swarm_init`, `swarm_status`... | Рой и его конфигурация |
| **Workflows** | `workflow_create`, `workflow_execute`... | Шаблоны и состояние выполнения |
| **Autopilot** | `autopilot_enable`, `autopilot_predict`... | Модель предсказаний |
| **Neural** | `neural_train`, `neural_predict`... | Обученные модели |

### Сводка: что где видно

| Подсистема | Сессии одного проекта | Между проектами (stdio) | ruflo-hub |
|---|---|---|---|
| Memory, паттерны, эмбеддинги | ✓ (общий `.swarm/`) | ✓ (общий `.swarm/`) | ✓ |
| Claims, tasks, hive-mind | ✓ (общий процесс) | **✗** (разные процессы) | ✓ |
| Agents, coordination, swarm | ✓ (общий процесс) | **✗** | ✓ |
| Перезапуск процесса (`/mcp`) | In-memory теряется | In-memory теряется | In-memory теряется |

### Решение для мультипроектной работы: ruflo-hub

Чтобы claims, tasks, hive-mind работали **между проектами**, нужен **один постоянно работающий процесс ruflo**, обёрнутый в HTTP. Готовое решение — [ruflo-hub](https://github.com/jazz-max/ruflo-hub):

```bash
git clone https://github.com/jazz-max/ruflo-hub.git
cd ruflo-hub && cp .env.example .env
docker compose up -d
```

```
Проект A ──HTTP──┐
Проект B ──HTTP──┤── ruflo-hub (один процесс) ── .swarm/memory.db
Проект C ──HTTP──┘        ↑
                    всё in-memory состояние
                    живёт в одном процессе
                    и видно всем проектам
```

### Обходной путь: задачи через memory

Без ruflo-hub для передачи задач между проектами можно использовать `memory_store` / `memory_search` с namespace `tasks` — они пишут в общий `memory.db` и видны отовсюду.

```
# Проект A: поставить задачу
> Сохрани в ruflo-personal namespace tasks ключ fix-auth-redirect:
> Статус: open. Исправить редирект после логина. Теги: bug, auth, open

# Проект B: найти задачи
> Покажи записи в ruflo-personal namespace tasks

# Проект B: закрыть задачу (upsert)
> Обнови в ruflo-personal ключ fix-auth-redirect в namespace tasks:
> Статус: done, выполнено 2026-04-16
```

## Личный ruflo: общая память между проектами (stdio)

### Проблема

При настройке `ruflo-personal` как stdio MCP на user level (`~/.claude.json`):

```json
"ruflo-personal": {
  "type": "stdio",
  "command": "npx",
  "args": ["ruflo@latest", "mcp", "start"]
}
```

Каждый Claude Code запускает **свой процесс** ruflo с `cwd` текущего проекта. Memory-bridge (`@claude-flow/cli/dist/src/memory/memory-bridge.js`) жёстко использует `process.cwd()`:

```js
function getDbPath(customPath) {
    const swarmDir = path.resolve(process.cwd(), '.swarm');
    if (!customPath)
        return path.join(swarmDir, 'memory.db');
    // Path traversal protection — путь за пределами cwd игнорируется
    const cwd = process.cwd();
    if (!resolved.startsWith(cwd)) {
        return path.join(swarmDir, 'memory.db'); // fallback
    }
}
```

**Результат:** из проекта Alpha сохраняешь 198 записей, из проекта Beta — 0. Разные `.swarm/memory.db` в каждом проекте.

### Почему env-переменные не помогают

`CLAUDE_FLOW_MEMORY_PATH` и `CLAUDE_FLOW_DATA_DIR` документированы в README ruflo, но **memory-bridge их не читает**. Они используются только в шаблонах документации (`claudemd-generator.js`) и в описании memory-specialist агента, но не в реальном коде MCP-сервера.

### Решение: обёртка с фиксированным cwd

Создать скрипт-обёртку, который делает `cd` в общую папку перед запуском ruflo:

**1. Создать папку и скрипт:**

```bash
mkdir -p ~/.ruflo-personal

cat > ~/.ruflo-personal/start.sh << 'EOF'
#!/bin/bash
cd ~/.ruflo-personal
exec npx ruflo@latest mcp start
EOF

chmod +x ~/.ruflo-personal/start.sh
```

**2. Обновить `~/.claude.json`:**

```json
"ruflo-personal": {
  "type": "stdio",
  "command": "bash",
  "args": ["/Users/<username>/.ruflo-personal/start.sh"],
  "env": {}
}
```

> **Важно:** В `args` нужен **абсолютный путь** (`/Users/<username>/...`), а не `~/.ruflo-personal/...`. Тильда `~` — это shell expansion, она раскрывается только при парсинге командной строки оболочкой. Claude Code запускает MCP-серверы через `spawn()`, передавая аргументы напрямую процессу без shell-обработки. Bash получит литеральную строку `~/.ruflo-personal/start.sh` и не найдёт такой файл.

**3. Перенести существующие данные (если есть):**

```bash
# Скопировать .swarm из проекта, где уже были записи
cp -r /path/to/project/.swarm ~/.ruflo-personal/
```

Теперь **все** Claude Code сессии (из любого проекта) будут использовать единую базу `~/.ruflo-personal/.swarm/memory.db`.

### Альтернативные варианты

| Вариант | Плюсы | Минусы |
|---------|-------|--------|
| **Обёртка с cd** (рекомендуемый) | Одно изменение в ~/.claude.json, не трогает проекты | Нет |
| **Symlink .swarm/** в каждом проекте | Работает без изменения конфига | Нужно добавлять symlink в каждый новый проект |
| **SSE-сервер** из фиксированной директории | Самый «правильный» | Нужен постоянно работающий процесс |

## Гибридная схема: личный ruflo + командные серверы

Типичная ситуация: один разработчик участвует в нескольких проектах с разными командами, плюс имеет собственные проекты. Решение — несколько инстансов ruflo с разными скоупами.

### Архитектура

```
┌───────────────────────────────────────────────────────┐
│  Командный сервер A (проект Alpha)                    │
│  ruflo-hub --port 3001                             │
│  Пользователи: вы + команда проекта Alpha             │
└──────────────────────────┬────────────────────────────┘
                           │
┌──────────────────────────┼────────────────────────────┐
│  Командный сервер B (проект Beta)                     │
│  ruflo-hub --port 3002                             │
│  Пользователи: вы + команда проекта Beta              │
└──────────────────────────┼────────────────────────────┘
                           │
┌──────────────────────────┼────────────────────────────┐
│  Личный ruflo (stdio или ruflo-hub)                │
│  Импорт памяти из всех проектов                       │
│  Только для вас, доступен в любом проекте             │
│  stdio: memory расшаривается, claims — нет            │
│  ruflo-hub: всё расшаривается между проектами      │
└──────────────────────────┴────────────────────────────┘
```

### Конфигурация Claude Code

**1. Личный ruflo — глобально** (user scope):

Доступен во всех проектах, аккумулирует личный опыт.

**Вариант A: stdio (простой, memory расшаривается, claims — нет)**

```bash
# Добавить (с обёрткой для общей базы, см. секцию «Личный ruflo: общая память»)
claude mcp add ruflo-personal -s user -- bash /Users/<username>/.ruflo-personal/start.sh

# Проверить
claude mcp get ruflo-personal

# Удалить
claude mcp remove ruflo-personal -s user
```

**Вариант B: ruflo-hub (всё расшаривается между проектами)**

```bash
# Поднять личный ruflo-hub (Docker)
git clone https://github.com/jazz-max/ruflo-hub.git ~/ruflo-personal-server
cd ~/ruflo-personal-server && cp .env.example .env
docker compose up -d

# Добавить в Claude Code
claude mcp add ruflo-personal -s user --transport http --url http://localhost:3000/mcp

# Или через ~/.claude.json:
# "ruflo-personal": {
#   "type": "http",
#   "url": "http://localhost:3000/mcp"
# }
```

> В варианте B claims, tasks, hive-mind работают между всеми проектами и сессиями. Минус — нужен запущенный Docker-контейнер.

**2. Командный ruflo — на уровне проекта** (project scope):

Коммитится в git — каждый член команды автоматически получает доступ.

```bash
# В каталоге проекта Alpha
claude mcp add ruflo-team -s project --transport http --url http://server-alpha:3001/mcp

# В каталоге проекта Beta
claude mcp add ruflo-team -s project --transport http --url http://server-beta:3002/mcp
```

> Имя `ruflo-team` одинаковое в обоих проектах — для разработчика интерфейс единообразный, а URL разный.

### Что видит Claude Code в каждом проекте

| Контекст | MCP-серверы | Источник настроек |
|----------|-------------|-------------------|
| Проект Alpha | `ruflo-personal` + `ruflo-team` (→ server-alpha) | global + project |
| Проект Beta | `ruflo-personal` + `ruflo-team` (→ server-beta) | global + project |
| Личный проект | `ruflo-personal` | только global |

### Промпты в контексте нескольких ruflo

```
# В проекте Alpha — Claude видит оба сервера
> Сохрани в ruflo-team: решение проблемы с кодировкой...

> Поищи в ruflo-personal: как мы решали кодировку в других проектах?

# В проекте Beta — Claude видит другую пару
> Сохрани в ruflo-team: nginx конфиг для проксирования...

> Поищи в ruflo-personal: были ли похожие nginx настройки?

# В личном проекте — только personal
> Поищи в ruflo-personal: паттерны авторизации из всех проектов
```

### Первоначальное наполнение личного ruflo

```
# Импортировать память из всех проектов Claude Code
> Импортируй в ruflo-personal память из всех проектов

# Claude выполнит:
memory_import_claude(allProjects: true)
# → все файлы памяти → эмбеддинги → семантический поиск по всем проектам
```

Личный ruflo становится **мостом между проектами** — туда стекается опыт из всех, а командные ruflo изолированы друг от друга.

### Потоки знаний

```
Проект Alpha ──→ ruflo-team-alpha ──→ команда Alpha
     │
     └──→ ruflo-personal ←──────┐
                                │
Проект Beta  ──→ ruflo-team-beta ──→ команда Beta
     │                          │
     └──→ ruflo-personal ←──────┘
                  │
Личные проекты ───┘

ruflo-personal = ваш личный "мозг" со знаниями из всех проектов
ruflo-team-*   = командная память, изолированная по проектам
```

## Рекомендуемый подход

### Для одного разработчика

1. **Ruflo через обёртку** (stdio + фиксированный cwd) в `~/.claude.json` — общая база для всех проектов (см. секцию «Личный ruflo: общая память между проектами»)
2. **`memory_import_claude(allProjects: true)`** — объединить память всех проектов
3. **Namespace по проектам** — `project:{name}` для организации

### Для команды (один проект)

1. **Ruflo MCP-сервер** с HTTP-транспортом на выделенной машине с PostgreSQL (RuVector)
2. **`.claude/settings.json` в репозитории** — все члены команды автоматически подключены
3. **`CLAUDE.md`** — источник истины для правил проекта (общий через git)
4. **Namespace-конвенция** — `dev:`, `project:`, `team:`, `shared`

### Для нескольких команд и проектов

1. **Личный ruflo** глобально — мост между проектами, накопление опыта
2. **Командный ruflo** в каждом проекте — изолированная командная память
3. **Единое имя** `ruflo-team` в `.claude/settings.json` проектов — единообразный интерфейс
4. **Git** — основной способ обмена кодом и документацией

Ruflo усиливает индивидуальную продуктивность и обеспечивает командную память, а код и документация живут в git.
