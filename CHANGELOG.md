# Changelog

Формат — [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), версии — [SemVer](https://semver.org/lang/ru/).

Образ публикуется в Docker Hub: `jazzmax/ruflo-hub:<version>` (для каждого выпуска), `:latest` — всегда последний main, `:<git-sha>` — для трейсинга.

## [Unreleased]

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

[Unreleased]: https://github.com/jazz-max/ruflo-hub/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/jazz-max/ruflo-hub/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/jazz-max/ruflo-hub/releases/tag/v1.0.0
