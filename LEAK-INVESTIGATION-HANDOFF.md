# Handoff: утечка памяти ruflo-hub — контекст для агента-фиксера

> Составлено 2026-06-19. Ты запущен из папки `ruflo-server` (репо `ruflo-hub`, v1.1.2).
> Задача: **починить load-correlated утечку памяти**. Ниже — весь собранный контекст, начинай отсюда, не переоткрывай заново.

---

## TL;DR

- Течёт **НЕ твой код** (`server.mjs` стабильно ~59 МБ), а **обёрнутый upstream-процесс `ruflo mcp start`** — это пакет **`ruflo` (claude-flow) v3.12.3**, который Dockerfile ставит как `npm install -g ruflo@latest` (**не запинён**).
- Утечка **зависит от нагрузки MCP-вызовов**, а не от времени: под активным трафиком heap процесса `ruflo mcp start` растёт ~**160 МБ/час**.
- Версия hub'а 1.1.2 (с твоим single-flight фиксом) **не при чём** — тот фикс лечил orphaning дочерних процессов на стороне proxy, он работает (children=1, орфанов нет). Это **другая, остаточная утечка** — heap самого claude-flow.
- **Где чинить:** upstream `ruvnet/ruflo` (claude-flow) ИЛИ обойти на стороне hub (bounding/периодический перезапуск mcp-child). Containment уже стоит (cap + restart), но это симптоматика.

---

## Доказательства (prod vs local, одна версия 1.1.2)

| | прод (`ruflo`) | локаль (`ruflo-server-ruflo-my-1`) |
|---|---|---|
| Версия hub | 1.1.2 | 1.1.2 |
| upstream ruflo | v3.12.3 | v3.12.3 |
| База после рестарта 2026-06-18 | ~150 МБ | ~178 МБ |
| Через ~18ч | **188 МБ (плоско)** | **3.02 ГБ (~160 МБ/ч)** |
| children (`mcp start`) | 1 | 1 |

**Ключевой вывод:** версия и аптайм одинаковы — разница только в **трафике**. Прод сейчас простаивает (клиентские MCP-коннекты к нему падают из-за сетевой проблемы `bad record mac`), поэтому heap плоский. Локаль получает весь трафик (`ruflo-personal` MCP из локальных сессий Claude Code) → heap пухнет. Прежние 36 ГБ на проде накопились за 6 недель **активного** трафика.

Разбивка процессов в контейнере (локаль, под нагрузкой):
```
node /app/server.mjs            ->   59 МБ   (proxy/hub — НЕ течёт)
node /usr/local/bin/ruflo mcp start -> 3.3 ГБ   (claude-flow — ВОТ ОНО)
```

## Что уже исключено

- **Старый leak orphaned children (1.1.0→1.1.1)** — починен твоим коммитом `6b78bbe` (single-flight reconnect + kill stale stdio children), версия поднята до 1.1.2. Проверено: `children=1` на обеих средах, орфанов нет. Это НЕ он.
- **«Старая версия на сервере»** — нет: образ прода собран 2026-05-01 14:11 UTC, на 16 мин позже фикса (13:55 UTC), версия 1.1.2. Локаль вчера пересобрана до 1.1.2.

## Архитектура (как устроено)

- `server.mjs` — HTTP/MCP-proxy (Express-подобный), оборачивает stdio-процесс `ruflo mcp start` (upstream claude-flow). Раздаёт `/health`, `/stats`, `/mcp`, `/setup`, `/update-bundle`.
- Стейт claude-flow: `/app/.swarm/memory.db` (sql.js + HNSW векторный индекс), `/app/.claude-flow` (config/stubs). Тома персистентны (`ruflo-memory`, `ruflo-state` / локально `ruflo-my-memory`, `ruflo-my-state`).
- Dockerfile: `node:22-alpine`, `npm install -g ruflo@latest pg`, `ENTRYPOINT /entrypoint.sh`.
- Утечёт именно долгоживущий `ruflo mcp start` — его heap растёт с числом обработанных tool-вызовов.

## Гипотезы (что именно течёт в claude-flow v3.12.3)

Проверять в порядке вероятности:
1. **Неограниченный in-memory кэш** в claude-flow на каждый tool-вызов (результаты, эмбеддинги, контекст сессии не вычищаются).
2. **Рост HNSW-индекса / memory.db в памяти** — sql.js держит всю БД в RAM; если каждый вызов что-то пишет, RAM-образ пухнет.
3. **Накопление pattern-store / trajectory / session-стейта** (CHANGELOG уже ссылается на upstream-баг `ruvnet/ruflo#1647`: trajectory-* не персистится + null-derefs в memory_store).
4. **Утечка слушателей событий / незакрытых хендлов** per tool-call в долгоживущем процессе.

## План диагностики

```bash
# 1. Воспроизвести под нагрузкой локально (контейнер уже течёт — наблюдать вживую):
watch -n 30 'docker exec ruflo-server-ruflo-my-1 sh -lc "ps -eo rss,args | grep [m]cp.start"'

# 2. Heap-снимок процесса ruflo mcp start (node 22):
#    запустить mcp-child с --heapsnapshot-signal=SIGUSR2, послать сигнал на пике, открыть в Chrome DevTools.
#    Точку запуска искать в server.mjs (как спавнится `ruflo mcp start`) — добавить NODE_OPTIONS.
#    Сравнить два снимка (low vs high RAM) → retained-объекты = течь.

# 3. RSS vs node heap: если RSS >> heapTotal — течёт нативщина (sql.js/HNSW буферы), а не JS-heap.
docker exec ruflo-server-ruflo-my-1 sh -lc 'node -e "console.log(process.memoryUsage())"'  # для server.mjs; для child нужен inspector

# 4. Версия upstream и changelog:
docker exec ruflo-server-ruflo-my-1 ruflo --version   # сейчас v3.12.3
npm view ruflo versions --json | tail -20             # есть ли новее с фиксом памяти
```

## Варианты фикса

1. **Запинить/обновить `ruflo`**: в Dockerfile `ruflo@latest` → конкретная версия. Проверить, есть ли версия >3.12.3 с фиксом памяти; либо откатиться на стабильную. Это первый и самый дешёвый шаг.
2. **Обойти на стороне hub** (`server.mjs`): периодически перезапускать stdio-child `ruflo mcp start` по порогу RSS или по числу обработанных вызовов (graceful: дождаться idle, респавнить). Уже есть инфраструктура single-flight reconnect — можно переиспользовать.
3. **Ограничить heap child'а**: `NODE_OPTIONS=--max-old-space-size=...` для `ruflo mcp start` — заставит V8 чаще GC (поможет только если течёт JS-heap, не нативщина).
4. **Завести/найти upstream-issue** в `ruvnet/ruflo` (claude-flow) с heap-снимком — корневой фикс там.

## Containment уже развёрнут (прод + локаль)

- **Cap + restart** (cgroup-OOM прибьёт сам ruflo, не остальное; авто-рестарт):
  - прод: `mem_limit: 8g`, в `/home/woo-crm/ruflo-hub/docker-compose.yml` (+ runtime `docker update`).
  - локаль: `mem_limit: 4g`, в `docker-compose.override.yml` (сервис `ruflo-my`).
- **Мониторинг на проде** (cron):
  - `*/15 * * * * /home/woo-crm/ruflo-hub/rss-logger.sh` → `ruflo-rss.log` (RSS + children + swap).
  - `5 13 * * * /home/woo-crm/ruflo-hub/leak-verdict.sh` → `ruflo-leak-verdict.log` (авто-вердикт рост/стабильно).

## Среды

| | прод | локаль (этот мак) |
|---|---|---|
| Контейнер | `ruflo` | `ruflo-server-ruflo-my-1` |
| Хост-путь | `/home/woo-crm/ruflo-hub/` | этот репо `ruflo-server/` |
| Доступ | `ssh 1pix.biz` (SSH флапает — `bad record mac`) | локальный docker |
| Образ | `jazzmax/ruflo-hub:latest` | `ruflo-server-ruflo-my` (local build) |
| MCP | `ruflo-team` (ruflo.1pix.biz) | `ruflo-personal` |
| Cap | 8g | 4g |

## Ключевые файлы и ссылки

- `server.mjs` — proxy/hub, точка спавна `ruflo mcp start` (искать здесь для воркэраунда #2/#3).
- `Dockerfile` — `npm install -g ruflo@latest` (запинить здесь, фикс #1).
- `CHANGELOG.md` — история; запись про single-flight фикс (orphaned children, 4.2 ГБ за 4 дня) и ссылка на `ruvnet/ruflo#1647`.
- `docker-compose.yml` / `docker-compose.override.yml` — сервисы `ruflo` / `ruflo-my`, лимиты памяти.
- Коммит фикса children: `6b78bbe fix(proxy): single-flight reconnect, kill stale stdio children` (ввёл v1.1.2).

---

**Старт для тебя:** воспроизведи рост локально (он уже идёт), сними два heap-снимка процесса `ruflo mcp start` (low vs high RSS), сравни retained-объекты. Параллельно проверь `npm view ruflo versions` — нет ли свежее 3.12.3 с фиксом памяти (быстрый win — просто запинить новую версию в Dockerfile). RSS>>heapTotal ⇒ нативная течь (sql.js/HNSW), иначе JS-heap.
