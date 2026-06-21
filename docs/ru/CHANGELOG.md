# Changelog

Формат — [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), версии — [SemVer](https://semver.org/lang/ru/).

Образ публикуется в Docker Hub: `jazzmax/ruflo-hub:<version>` (для каждого выпуска), `:latest` — всегда последний main, `:<git-sha>` — для трейсинга.

## [Unreleased]

## [1.2.1] — 2026-06-21

### Added
- **Build-time патч корневой причины течи** (`scripts/patch-sqljs-leak.cjs`, встроен в Dockerfile после `npm install -g ruflo`). Анализ retainer-путей heap-снимка указал корень: in-memory ФС (MEMFS) sql.js накапливает файлы `dbfile_<random>` (по одному полному образу `memory.db` — 11 МБ локально, 60 МБ на проде — на каждое открытие БД), потому что `createDatabase()` в `@claude-flow/memory` не кэширует инстансы и перезагружает всю БД в новый `SQL.Database` на каждый вызов; отброшенная обёртка собирается GC, но её MEMFS-файл освобождает только `db.close()`, который не зовётся. Патч оборачивает `createDatabase()` promise-кэшем по `(path|provider|dimensions)` — один backend открывается один раз и переиспользуется, повторные полные загрузки БД исчезают. Идемпотентен и best-effort: если upstream изменит файл — пишет warning, а RSS-watchdog (1.2.0) всё равно держит течь.
- Заведён upstream-issue [ruvnet/ruflo#2432](https://github.com/ruvnet/ruflo/issues/2432); полная диагностика — в [`UPSTREAM-ISSUE-sqljs-memfs-leak.md`](../../UPSTREAM-ISSUE-sqljs-memfs-leak.md).

### Verified
- Пропатченный образ: `memory_store` / `memory_search` работают (эмбеддинги 384-dim, `stored: true`) на свежей БД; sql.js-бэкенд здоров, 302 tools. Патч не меняет байты БД — предсуществующее `database disk image is malformed` на (пустой) локальной personal-БД — это повреждение от прежних негрейсфул-убийств child'а, не связанное с патчем.

## [1.2.0] — 2026-06-19

### Added
- **RSS-watchdog для дочернего `ruflo mcp start` в `server.mjs`** — containment для load-correlated утечки памяти в upstream claude-flow. Диагностика (см. [`LEAK-INVESTIGATION-HANDOFF.md`](../../LEAK-INVESTIGATION-HANDOFF.md)): течёт **не** наш proxy и **не** JS-heap V8. `process.memoryUsage()` живого child показал `heapTotal ≈ 24 МБ` (плоско), но `external ≈ 1.3 ГБ` / `arrayBuffers ≈ 1.1 ГБ` и растёт — нативные буферы (эмбеддинги / HNSW / буферы результатов) копятся на каждый tool-вызов, ~160 МБ/ч под нагрузкой. `memory.db` на диске всего 11 МБ, значит это утёкшие буферы, а не образ БД.
  - Watchdog читает RSS child'а из `/proc/<pid>/status` (через `transport.pid` из SDK) раз в `RUFLO_WATCHDOG_INTERVAL_MS` (по умолчанию 60 с). При превышении `RUFLO_CHILD_MAX_RSS_MB` помечает респавн и выполняет его **как только child простаивает** (`inFlight === 0`), переиспользуя `connectToRuflo()` — тот убивает старого ребёнка перед спавном нового, разом сбрасывая утёкшую нативную память. Если трафик не даёт уйти в idle за `RUFLO_RESPAWN_IDLE_TIMEOUT_MS` (по умолчанию 30 с), респавн форсируется (запросы в полёте прикрыты прозрачным retry в `callToolReliably`).
  - `RUFLO_CHILD_MAX_RSS_MB=0` отключает watchdog. Дефолты в compose: `2500` для `ruflo-my` (cap 4 ГБ), `3000` для `ruflo` (cap 8 ГБ) — оба ниже cgroup `mem_limit`, чтобы watchdog срабатывал раньше OOM-backstop.
  - В `/health` добавлены `childRssMB`, `childMaxRssMB`, `childRespawnCount`, `lastChildRespawnAt`, `lastChildRespawnRssMB`, `inFlight`. `lastReconnectReason` теперь может быть `rss-threshold`.
  - Проверено end-to-end на живом контейнере (заниженный тестовый порог): респавн срабатывает по порогу, после респавна tools отдаются, число процессов child остаётся ровно 1 между циклами — орфаны не копятся (single-flight reconnect из 1.1.2 держит).

### Notes
- **Не исправлено: корневая причина.** `ruflo@3.12.4` (latest на момент релиза) побайтово идентичен `3.12.3`, кроме `package.json` (бамп версии + новая зависимость `agentic-flow`), поэтому запинивание свежего `ruflo` не помогает. `--max-old-space-size` тут бесполезен — течёт нативщина (`arrayBuffers`/`external`), а не old-space V8. Корневой фикс — на стороне upstream `ruvnet/ruflo`; этот релиз лишь ограничивает симптом.

## [1.1.2] — 2026-05-01

### Fixed
- **Утечка stdio-детей `ruflo mcp start` в `server.mjs`.** В 1.1.0 авто-реконнект (`transport.onclose` + `callTool-failure` retry) не был single-flight: N параллельных HTTP-запросов, поймавших `Not connected`, спавнили N свежих `ruflo mcp start` процессов; глобальный `client` перезаписывался последним, но старые child-процессы оставались жить — их stdio-pipes держал транспорт-объект, на который никто уже не ссылался. За 4 дня в проде накопилось 123 осиротевших процесса и **4.2 ГБ RAM** (cgroup `anon`).
- **Single-flight `connectToRuflo`** через `connectingPromise` — все параллельные вызовы дожидаются одного коннекта.
- **Явный SIGTERM старого child'а** перед спавном нового: `transport.close()` (fire-and-forget, чтобы не блокировать реконнект на 0–4 c grace-периода SDK).
- **Onclose от стейл-транспортов игнорируется** (`transport !== currentTransport`) — иначе агония осиротевшего ребёнка триггерила лишний реконнект.
- Стресс-тест: 5 раундов × 8 параллельных запросов + `kill -9` child'а посреди — каждый раунд ровно 1 reconnect, 1 child, RAM стабильна на 79 МБ. До патча тот же сценарий оставлял 4–5 осиротевших процессов за раунд.

## [1.1.1] — 2026-04-29

### Fixed
- **Документация: пропущенные volumes в примерах встраивания.** Все три варианта в README (en + ru) монтировали только `ruflo-pgdata`, без `ruflo-memory:/app/.swarm` и `ruflo-state:/app/.claude-flow`. Из-за этого при `docker compose pull && up -d` контейнер пересоздавался и терял `memory.db`. Добавлены volume mappings во все варианты + крупный WARNING-блок в начале раздела «Embedding as a service».
- Раздел [Migrating an existing deployment to volumes](../../README.md#migrating-an-existing-deployment-to-volumes) — пошаговый план миграции живых данных в named volume без потерь, для тех кто уже задеплоил без volumes.

### Added
- **Runtime-warning в `entrypoint.sh`**: проверяет через `mountpoint -q`, что `/app/.swarm` и `/app/.claude-flow` примонтированы из volume. Если нет — крупный блок в `stderr` контейнера с точной YAML-вставкой для compose. Работает на каждом старте.

## [1.1.0] — 2026-04-27

### Added
- **SONA pattern bridge** в client bundle (`templates/intelligence-bridge.cjs` + хуки в `hook-handler.cjs`). Каждое действие Claude Code (`Edit`/`Bash`/`task-complete`/`session-end`) пишется как pattern в `pattern`-namespace через `hooks_intelligence_pattern-store`. На session-end сохраняется агрегированный summary.
- **Авто-реконнект** stdio child `ruflo mcp start` в `server.mjs`. При смерти child (`transport.onclose`) — back-off-таймер от 0.5 до 5 c с автоматическим respawn. `callTool` с прозрачным retry'ем при `Not connected`/`Connection closed`.
- **Persistent stderr-лог** ruflo CLI: `/app/.swarm/ruflo-stderr.log` (на volume, переживает рестарт контейнера). Туда же пишутся отметки о каждой попытке реконнекта с причиной.
- **Расширенный `/health`**: теперь включает `state`, `serverStartedAt`, `currentConnectedSince`, `reconnectCount`, `reconnectFailures`, `lastReconnectAt`, `lastReconnectReason`. Возвращает `503` если transport не в `ready` (Docker healthcheck перестаёт врать).
- **Stub-файлы для `system_health`**: `/app/.claude-flow/{config.json,memory/store.json}` создаются в `entrypoint.sh`, чтобы клиенты не предлагали `ruflo init`. Рядом всегда лежит маркер `.migrated-to-sqlite`, иначе `memory_store` падает с null-deref на пустом stub.
- **Раздача `intelligence-bridge.cjs`** через `/setup` и `/update-bundle`. `/update-bundle` теперь всегда перезаписывает helpers (они серверные).
- **Operational notes** в README (en + ru): известные особенности `system_health`, `claude_flow.embeddings`, `memory_bridge_status`, фоновые контроллеры.

### Fixed
- **Краш `memory_store: Cannot convert undefined or null to object`** — миграционный маркер `.migrated-to-sqlite` отключает code path в `memory-tools.js`, который ошибочно считал stub-`store.json` legacy-дампом и вызывал `Object.keys(legacyStore.entries).length` на `undefined`.
- **Утрата записей при крахе stdio child**: до 1.1.0 контейнер мог 13+ часов отвечать `Not connected` на каждый MCP-вызов, а `/health` показывать `200 OK` (использовался кэш `tools/list` со старта). Теперь child авто-перезапускается, `/health` сигнализирует degraded-state.
- **Неточности в документации**: убраны упоминания `supergateway` (не используется в этой сборке — у нас собственный Express-прокси `server.mjs`). Заменено `all-MiniLM-L6-v2 384-dim` на корректное `1536-dim (RuVector)` с пометкой про активный sql.js (768-dim) backend.
- **Backup-инструкции** переписаны (en + ru): бэкапить нужно volume `<service>-memory`, а не `pg_dump` — основная память живёт в `/app/.swarm/memory.db`, PostgreSQL обычно пуст и используется только для `ruvector import/export`.

### Reported upstream
- [ruvnet/ruflo#1647](https://github.com/ruvnet/ruflo/issues/1647): `trajectory-*` API не персистит трекинг-данные в SQLite + null-deref в `hooks_intelligence_stats` / `memory_bridge_status` / migration code в `memory_store`.

## [1.0.0] — 2026-04-22

Первая отслеженная версия. Основные фичи к этому моменту:

- Docker-обёртка вокруг `ruflo` CLI: `server.mjs` (Express + MCP stdio client) + Dockerfile + docker-compose.
- `/mcp` (Streamable HTTP JSON-RPC), `/health`, `/stats` (с `dbSizeKB`, intelligence-метриками).
- `/setup` и `/update-bundle` — self-configuring shell scripts, разворачивающие `.claude/helpers/{auto-memory-hook.mjs,hook-handler.cjs,statusline.cjs}` + `.claude/{skills,agents,commands}` в проекте.
- Memory bridge: `auto-memory-hook.mjs` — импорт паттернов из ruflo-personal на `SessionStart`, sync на `Stop`.
- Опциональный PostgreSQL/pgvector (lean mode, если PG недоступен). Авто-инициализация схемы `claude_flow` через `ruvector init`.
- Поддержка мульти-инстансов (несколько контейнеров на разных портах с отдельными PG-базами `ruflo_alpha`, `ruflo_beta`).
- CI: GitHub Actions собирает образ на каждый push в `main` и еженедельно (Mon 6:00 UTC), пушит `latest` + `<sha>` в Docker Hub.
- Двуязычная документация (en + ru).

[Unreleased]: https://github.com/jazz-max/ruflo-hub/compare/v1.1.2...HEAD
[1.1.2]: https://github.com/jazz-max/ruflo-hub/compare/v1.1.1...v1.1.2
[1.1.1]: https://github.com/jazz-max/ruflo-hub/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/jazz-max/ruflo-hub/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/jazz-max/ruflo-hub/releases/tag/v1.0.0
