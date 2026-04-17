# Ruflo — практический гайд по использованию

Выжимка из официального README [ruvnet/ruflo](https://github.com/ruvnet/ruflo) без маркетинга. Что реально надо знать и делать.

---

## Что такое ruflo на самом деле

Оркестратор для Claude Code с 4 основными функциями:

1. **Хуки** — автоматически подбирают модель/агента под задачу, записывают паттерны, триггерят фоновые процессы
2. **Память** — векторная БД (HNSW) для паттернов, 3 уровня scope (проект/локальный/пользовательский)
3. **Swarm** — координация нескольких агентов в одной задаче (hierarchical/mesh/ring/star)
4. **Skills** — 130+ готовых сценариев (`sparc:coder`, `github-code-review`, и т.д.)

Главная идея из их же доков:

> **После `init` просто работай в Claude Code как обычно — хуки сами маршрутизируют задачи, учатся на успехах и координируют работу в фоне. 310+ MCP-tools нужны только для тонкого контроля.**

---

## Повседневные команды (что реально используется)

```bash
# Один раз — инициализация проекта
npx ruflo@latest init           # создаст .claude/, .claude-flow/, хуки и т.п.

# Обновление без потери данных
npx ruflo@latest init upgrade

# С добавлением новых skills/agents
npx ruflo@latest init upgrade --add-missing

# Проверить установку
npx ruflo@latest mcp list       # что доступно
node .claude/helpers/hook-handler.cjs stats   # статистика обучения
```

Всё остальное — через **MCP внутри Claude Code**, без CLI.

Для подключения к централизованному `ruflo-hub` вместо локальной установки используй `/setup`-скрипт из [ruflo-hub](https://github.com/jazz-max/ruflo-hub) — он настраивает хуки + мост памяти + MCP за один `curl | bash`.

---

## Самоучащийся цикл (Intelligence Loop)

Ключевой паттерн ruflo (ADR-050), который работает автоматически через хуки:

```
1. RETRIEVE    memory_search("похожие задачи")              ← перед началом
2. JUDGE       оценка что получилось / не получилось
3. DISTILL     memory_store("...", namespace="patterns")    ← после успеха
4. CONSOLIDATE фоновая агрегация паттернов (EWC++)
5. ROUTE       Q-learning выбирает агента/модель в след. раз
```

Ты ничего не делаешь руками — хуки `post-edit`, `post-task` триггерят это сами.

---

## 5 MCP-инструментов, которые реально стоит знать

Из 313 инструментов ruflo **эти закрывают 90% кейсов**:

| Tool | Когда вызывать | Зачем |
|------|----------------|-------|
| `memory_search` | **Перед** сложной задачей | Найти готовые паттерны команды |
| `memory_store` | **После** успешного решения | Записать в `namespace="patterns"` или `"shared"` |
| `swarm_init` | Когда задача делится на 3+ независимых треков | Координация + anti-drift |
| `agent_spawn` | В паре со `swarm_init` | Зарегистрировать роли (coder, tester, reviewer) |
| `hooks_route` | Не уверен какую модель брать | Q-learning выберет сам |

---

## Когда реально нужен swarm

Из их же документации — **только для сложных задач с явным параллелизмом**. Рекомендуемая anti-drift конфигурация:

```javascript
swarm_init({
  topology: "hierarchical",   // queen → workers, предотвращает «расползание»
  maxAgents: 8,               // не больше, иначе теряется фокус
  strategy: "specialized"     // чёткие роли, без пересечений
})
```

### Task → Agent Routing (их таблица)

| Код | Тип задачи | Агенты |
|-----|-----------|--------|
| 1 | Bug fix | coordinator, researcher, coder, tester |
| 3 | Feature | coordinator, architect, coder, tester, reviewer |
| 5 | Refactor | coordinator, architect, coder, reviewer |
| 7 | Performance | coordinator, perf-engineer, coder |
| 9 | Security | coordinator, security-architect, auditor |
| 11 | Memory | coordinator, memory-specialist, perf-engineer |

Для простых задач (одиночный bug-fix, мелкие правки) — **не нужен**. Claude Code сам справится через Task tool.

Подробнее про концепцию swarm/agent как «записей в БД, а не процессов» — см. [`swarm-management.md`](./swarm-management.md).

---

## Skills — то что многие упускают

Skills = сценарии которые Claude Code загружает по команде. У ruflo их 130+:

```
$sparc:architect              → SPARC Architect Mode
$sparc:coder                  → SPARC Coder Mode
$github-code-review           → PR review swarm
$swarm-orchestration          → паттерны swarm
$reasoningbank-intelligence   → learning patterns
$pair-programming             → driver/navigator
```

Вызываются через обычный запрос: *«используй skill sparc:architect для проектирования X»*.

### Популярные категории

| Категория | Примеры |
|-----------|---------|
| **SPARC** | `sparc:architect`, `sparc:coder`, `sparc:tester`, `sparc:debugger` |
| **V3 Core** | `v3-security-overhaul`, `v3-memory-unification`, `v3-performance-optimization` |
| **AgentDB** | `agentdb-vector-search`, `agentdb-optimization`, `agentdb-learning` |
| **Swarm** | `swarm-orchestration`, `swarm-advanced` |
| **GitHub** | `github-code-review`, `github-workflow-automation`, `github-multi-repo` |
| **Flow Nexus** | `flow-nexus-neural`, `flow-nexus-swarm`, `flow-nexus-workflow` |

---

## Практический workflow на день

```
1. Утро, первая сессия Claude Code:
   - Hook SessionStart → auto-memory-hook.mjs import
   - Из ruflo-hub в контекст подтянулись паттерны команды за вчера

2. Начинаю задачу «добавить фичу X»:
   - (я) «найди в памяти что мы делали похожего»
   - Claude: mcp__ruflo__memory_search("похожее на X")
   - Claude видит паттерн, адаптирует

3. Задача крупная, пять треков:
   - (я) «используй hierarchical swarm из 6 агентов»
   - Claude: swarm_init + 6× agent_spawn с ролями coder/tester/arch/...
   - Claude внутри своей сессии Task tool параллелит работу

4. Задача сложная, хочу учесть best practices:
   - (я) «используй skill sparc:architect»
   - Claude загружает SPARC-сценарий, пошагово проектирует

5. Задача решена:
   - Hook post-task → автоматически memory_store паттерна
   - Stop hook → auto-memory-hook.mjs sync → шарит с командой

6. Вечером:
   - Никаких cleanup не надо, всё персист в ruflo-hub volumes
```

---

## 3-tier model routing (экономия API-расходов)

Ruflo автоматически маршрутизирует задачи на оптимальный handler:

| Tier | Handler | Латентность | Стоимость | Кейсы |
|------|---------|-------------|-----------|-------|
| **1** | Agent Booster (WASM) | <1ms | $0 | var→const, add-types, remove-console |
| **2** | Haiku/Sonnet | 500ms-2s | $0.0002-$0.003 | Bug fixes, refactoring, feature implementation |
| **3** | Opus | 2-5s | $0.015 | Architecture, security design, distributed systems |

Routing: Q-learning с epsilon-greedy exploration, sub-millisecond decision latency. Экономия 30-50% токенов.

### Сигналы в выводе хуков

```bash
# Agent Booster доступен — LLM пропускаем
[AGENT_BOOSTER_AVAILABLE] Intent: var-to-const
→ Use Edit tool directly, instant (regex-based, no LLM call)

# Рекомендация модели для Task tool
[TASK_MODEL_RECOMMENDATION] Use model="haiku"
→ Pass model="haiku" to Task tool for cost savings
```

---

## Что стоит запомнить из официальных доков

- **«После init просто пиши в Claude нормально»** — не надо учить 310 tools. Хуки всё разрулят.
- **Agent Booster (WASM)** — простые трансформации (var→const, add-types) выполняются **без** LLM, мгновенно. Экономия $ и времени.
- **3-tier routing** — простое через WASM (0$), среднее через Haiku/Sonnet, сложное через Opus. Автоматически.
- **Skills > raw commands** — вместо «сделай swarm с такими-то настройками» скажи «используй skill $swarm-orchestration». Уже проверенный сценарий.

---

## Важно: большая часть «умных» фич требует настроенных хуков

Хуки настраиваются в `.claude/settings.json` — их ставит `init`. Если хуки отключены или не настроены, работать будет только то что ты вызовешь руками через MCP.

Скрипт `/setup` из [ruflo-hub](https://github.com/jazz-max/ruflo-hub) как раз и ставит базовые хуки + мост памяти + MCP-подключение — одной командой:

```bash
curl "http://<hub>:3000/setup?token=TOKEN&name=ruflo" | bash
```

---

## Установка ruflo локально (альтернатива ruflo-hub)

Если не нужен shared memory и хочешь ruflo как локальный инструмент:

```bash
# Пререкзит
npm install -g @anthropic-ai/claude-code

# Быстрый init
npx ruflo@latest init --wizard

# Или one-line с полной установкой
curl -fsSL https://cdn.jsdelivr.net/gh/ruvnet/ruflo@main/scripts/install.sh | bash -s -- --full

# MCP-интеграция в Claude Code
claude mcp add ruflo -- npx -y ruflo@latest mcp start
```

### Install profiles

| Profile | Size | Use Case |
|---------|------|----------|
| `--omit=optional` | ~45MB | Core CLI only (fastest) |
| Default | ~340MB | Full install with ML/embeddings |

---

## Итог в одном абзаце

Ruflo — это **Claude Code на стероидах**: ставишь через `init`, и он автоматически запоминает что работает, маршрутизирует задачи на дешёвые модели когда можно, хранит коллективную память команды и даёт 130+ готовых сценариев. Основная ценность для команды — **shared memory** (один раз нашёл решение — вся команда получила). Swarm и прочее — для сложных задач одного разработчика, не для координации команды.

---

## Sources

- [ruvnet/ruflo GitHub](https://github.com/ruvnet/ruflo)
- [ruflo README](https://github.com/ruvnet/ruflo/blob/main/README.md)
- [Ruflo v3.5 Release Overview](https://github.com/ruvnet/ruflo/issues/1240)
- [SitePoint: Deploying Multi-Agent Swarms with Ruflo](https://www.sitepoint.com/deploying-multiagent-swarms-with-ruflo-beyond-singleprompt-coding/)
