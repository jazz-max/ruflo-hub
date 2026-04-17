# Swarm Management в ruflo

Как ruflo управляет роями (swarms) и агентами. Практические наблюдения на ruflo@3.5.80 + объяснение, что считается что в статуслайне и зачем это нужно.

---

## Ключевая концепция: swarm и agent — это записи, не процессы

В ruflo **swarm** и **agent** — это **координационные записи в БД сервера** (sql.js `memory.db`). Никакие фоновые процессы не запускаются. CPU не расходуется. Память в контейнере не растёт.

```
swarm_init  → INSERT INTO swarms(id, topology, maxAgents, strategy, status='running')
agent_spawn → INSERT INTO agents(id, type, model, status='idle', health=1)
```

Это похоже на «заявку в очередь»: запись есть — но работать она начнёт только когда её кто-то возьмёт. Агент в статусе `idle` ничего не делает; он ждёт, пока Claude Code (или `claude -p`) пойдёт и выполнит задачу **от его имени**.

Поэтому:
- **Старые swarm'ы и idle-агенты в CPU не жрут** — их можно оставить без технического вреда.
- **Но они накапливают мусор в БД** — если каждая сессия спавнит новых без cleanup, через месяц в `agent_list` будут сотни записей.
- **Команда `autoScaling: true` в swarm config** — это не демон, а рекомендация для Claude Code. Сервер сам агентов не создаёт.

---

## Жизненный цикл

```
┌────────────┐  swarm_init({ topology, maxAgents, strategy })
│  (нет)     │──────────────────────────────────────────────→┐
└────────────┘                                               │
                                                             ▼
                                                       ┌───────────┐
                                                       │  running  │
                                                       └─────┬─────┘
                                                             │ agent_spawn({ agentType })
                                                             ▼
                                                       ┌───────────┐
                                                       │   idle    │←──┐
                                                       └─────┬─────┘   │
                                                             │         │ работа закончена
                       Claude Code Task tool / claude -p     │         │
                                                             ▼         │
                                                       ┌───────────┐   │
                                                       │  working  │───┘
                                                       └─────┬─────┘
                                                             │ agent_terminate
                                                             ▼
                                                       ┌───────────┐
                                                       │terminated │
                                                       └───────────┘

swarm_shutdown → status = 'shutdown', maxAgents зануляется у новых spawn
```

Важно:
- Агент сам не переходит из `idle` в `working` — его активирует **Claude Code через Task tool** или `claude -p`.
- Агент не «завершается автоматически» — он остаётся `idle` навсегда, пока не позвать `agent_terminate`.
- Swarm после `swarm_shutdown` остаётся в истории как завершённый, `totalSwarms` не уменьшается.

---

## Как реально выполняется работа

Ruflo **сам ничего не исполняет**. MCP-инструменты вида `agent_spawn` только регистрируют роль в БД. Работу делает Claude Code:

```
Пользователь: «напиши код через агента»
            ↓
Claude Code использует Task tool с ролью "coder"
            ↓
Claude Code делает `agent_spawn({ agentType: "coder" })` → ruflo создаёт запись
            ↓
Claude Code сам запускает subprocess `claude -p "напиши код"` с промптом, учитывающим роль
            ↓
Subprocess возвращает результат → Claude Code шлёт его пользователю
            ↓
Опционально: Claude Code пишет в ruflo `task_complete(agentId, result)` → запись в БД обновляется
```

Ключевой момент: «агент» — это **роль + routing подсказка для модели** (haiku/sonnet/opus), а не автономный исполнитель.

Поэтому вопрос «сколько агентов реально работает» не имеет смысла в привычном понимании — **все агенты или `idle`, или исполняются Claude Code как subprocess**. Одновременно «работающих» больше, чем параллельных Task tool calls, быть не может.

---

## Основные MCP-команды

### Создание и управление

| Команда | Что делает | Пример аргументов |
|---------|-----------|-------------------|
| `swarm_init` | Создаёт swarm (координационный контейнер) | `{ topology: "mesh", maxAgents: 5, strategy: "balanced" }` |
| `agent_spawn` | Регистрирует агента | `{ agentType: "researcher", task: "..." }` |
| `agent_list` | Возвращает всех агентов (есть `includeTerminated`) | `{}` |
| `agent_terminate` | Удаляет агента | `{ agentId: "agent-..." }` |
| `swarm_status` | Статус последнего (или по `swarmId`) swarm | `{}` |
| `swarm_shutdown` | Завершает swarm | `{ swarmId: "swarm-...", graceful: true }` |

### Топологии (`topology`)

| Значение | Идея | Когда |
|----------|------|-------|
| `hierarchical` | Queen → workers | Централизованные задачи |
| `mesh` | Все со всеми | Несвязанные параллельные задачи |
| `hierarchical-mesh` | Гибрид | Крупные проекты с подгруппами |
| `ring` | Последовательная передача | Pipeline-обработка |
| `star` | Центральный broker | Агрегация |
| `hybrid` | Автовыбор | Неясная задача |
| `adaptive` | Меняет на лету | Долгие жизненные циклы |

Практически: топология влияет на то, **как Claude Code будет думать о координации**. На сервер это записывается просто как строка; от неё не зависит CPU/память.

### Стратегии (`strategy`)

| Значение | Смысл |
|----------|-------|
| `specialized` | Узкие роли (researcher, coder, tester) не перепрыгивают |
| `balanced` | Агенты универсальны |
| `adaptive` | Выбор при spawn |

---

## Что показывает статуслайн (`🤖 Swarm`)

Формат: `🤖 Swarm ◉↻ [agentCount/maxAgents]`

Источник — `/stats` endpoint на ruflo-hub:
```json
{
  "swarm": {
    "active": true,
    "agentCount": 5,
    "maxAgents": 5,
    "topology": "mesh"
  }
}
```

Как это строится на сервере (`server.mjs /stats`):
1. Зовёт `swarm_status` → берёт `maxAgents`, `topology`, `active`
2. Зовёт `agent_list` → считает записи (без `terminated`)
3. Берёт `max(swarm_status.agentCount, agent_list.length)` — потому что `swarm_status.agentCount` часто отстаёт от реальности (баг ruflo)

**Число меняется только от явных команд:**
- `agent_spawn` → +1
- `agent_terminate` → −1
- `swarm_shutdown` → не трогает agent_list напрямую, но после него новые spawn не привязываются к закрытому swarm

**Число НЕ меняется автоматически**, даже если Claude Code делает Task tool (агенты `idle → working → idle` — счётчик один и тот же).

Индикатор `◉↻`:
- `◉` (зелёный) — swarm active
- `○` (серый) — нет активных swarm
- `↻` — данные с ruflo-hub (а не из локальных файлов проекта)

---

## Известные квирки ruflo@3.5.80

1. **`swarm_status.agentCount` отстаёт.** Часто показывает 0, даже если только что сделал `agent_spawn`. Используй `agent_list.total` для правды.

2. **`totalSwarms` не сбрасывается.** Даже после shutdown, счётчик остаётся. Это число созданных swarm за всё время жизни БД.

3. **Agents переживают shutdown.** `swarm_shutdown` не завершает агентов, они остаются `idle` и числятся в общем `agent_list`. Надо терминейтить отдельно.

4. **Один «активный swarm».** Несколько swarm_init создают несколько записей, но `swarm_status` без `swarmId` возвращает всегда последний.

5. **`autoScaling: true` не спавнит.** Это флаг для Claude Code, не для сервера.

6. **Persistence.** Swarm state пишется в `/app/.claude-flow/swarm/swarm-state.json` внутри контейнера. Persist работает **только** если в compose подмонтирован volume `/app/.claude-flow` (см. `docker-compose.yml`).

---

## Чистка старых записей

Быстрый цикл вручную через Claude Code:

```
> Покажи всех агентов в ruflo и shutdown всех swarm старше 24 часов.
```

Клод последовательно:
1. `mcp__ruflo__agent_list({ includeTerminated: false })` → массив агентов
2. Для каждого idle-агента старше порога: `mcp__ruflo__agent_terminate({ agentId })`
3. `mcp__ruflo__swarm_status()` для последнего swarm
4. `mcp__ruflo__swarm_shutdown({ swarmId, graceful: true })`

Через curl (без MCP):
```bash
# Список агентов
curl -X POST http://server:3201/mcp \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"agent_list","arguments":{}},"id":1}' \
  | jq -r '.result.content[0].text' | jq '.agents[].agentId'

# Завершение конкретного
curl -X POST http://server:3201/mcp \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"agent_terminate","arguments":{"agentId":"agent-..."}},"id":1}'
```

Рекомендация: завести cron-job в `ruflo-hub` контейнере, который раз в сутки подчищает агентов старше 7 дней. Пока не реализовано — делается вручную.

---

## Примеры

### Мини-swarm на одну задачу

```typescript
// 1. Инициализация
await mcp.swarm_init({ topology: 'mesh', maxAgents: 3, strategy: 'specialized' });

// 2. Три агента
await mcp.agent_spawn({ agentType: 'researcher', task: 'найди best practices' });
await mcp.agent_spawn({ agentType: 'coder', task: 'реализуй модуль' });
await mcp.agent_spawn({ agentType: 'tester', task: 'покрой тестами' });

// 3. Работа — через Claude Code Task tool (сам ruflo ничего не делает)
//    Claude Code использует роли и модели из agent_list

// 4. Очистка
const { agents } = await mcp.agent_list({});
for (const a of agents) {
  await mcp.agent_terminate({ agentId: a.agentId });
}
const status = await mcp.swarm_status({});
await mcp.swarm_shutdown({ swarmId: status.swarmId });
```

### Просто «посмотреть статус»

```bash
curl http://server:3201/stats
# {"swarm":{"active":true,"agentCount":3,"maxAgents":3,"topology":"mesh"}}
```

---

## Резюме одним абзацем

Swarm и agent в ruflo — это **координационные метаданные в БД**, а не автономные процессы. `swarm_init` и `agent_spawn` — дешёвые операции (несколько байт в БД). Реальную работу выполняет Claude Code через свой Task tool, используя записи агентов как подсказки по моделям и ролям. Статуслайн показывает количество **зарегистрированных** агентов, и это число меняется **только** от явных `agent_spawn`/`agent_terminate`. Периодически надо чистить старые idle-записи — они не жрут ресурсы, но мусорят в `agent_list`.
