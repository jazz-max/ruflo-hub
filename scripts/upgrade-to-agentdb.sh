#!/usr/bin/env bash
# upgrade-to-agentdb.sh — перенос памяти при апгрейде ruflo с 3.14.x на 3.15+.
#
# ЗАЧЕМ. Начиная с 3.15 (#2786) AgentDB-мост открывает ОТДЕЛЬНЫЙ файл
# `agentdb-memory.db`, а не `memory.db`, и автоматического переноса строк
# апстрим не делает — проверено по коду 3.38.11 и поведением на копии боевых
# данных. Без этого шага после апгрейда `memory_retrieve` отвечает
# `found: false` вместо ошибки: данные целы, но невидимы. Ровно так 2026-08-14
# «пропали» 149 записей namespace woo-crm.
#
# ЧТО ДЕЛАЕТ. Копирует активные строки `memory_entries` из `memory.db` в
# `agentdb-memory.db` (схему последнего создаёт сам новый образ при первом
# запуске). Записи со `status='deleted'` НЕ переносятся — это надгробия
# удалённых ключей; на проде их было 11 из 149.
#
# ПОРЯДОК ПРИМЕНЕНИЯ (проверен на стенде с копией боевых данных):
#   1. docker compose pull                       # новый образ
#   2. docker compose up -d                      # он создаёт agentdb-memory.db и его схему
#   3. ./upgrade-to-agentdb.sh --yes             # остановка, перенос, старт
#   4. проверить чтение известного ключа через MCP — скрипт делает это сам,
#      если передать --verify-key/--verify-ns
#
# ОТКАТ. До миграции — тривиален: вернуть прежний тег образа, `memory.db` не
# тронут. ПОСЛЕ миграции откат теряет всё, что записано на новой версии, потому
# что новые записи идут уже в `agentdb-memory.db`. То есть окно отката
# закрывается в тот момент, когда на новой версии пошёл трафик.
set -euo pipefail

CONTAINER=ruflo
VOLUME=""
BACKUP_ROOT="$(pwd)/backups"
SQLITE_IMAGE=alpine:3.20
UP_CMD=""
VERIFY_KEY=""
VERIFY_NS=""
APPLY=0

while [ $# -gt 0 ]; do
  case "$1" in
    --container)    CONTAINER="$2"; shift 2 ;;
    --backup-dir)   BACKUP_ROOT="$2"; shift 2 ;;
    --sqlite-image) SQLITE_IMAGE="$2"; shift 2 ;;
    --up-cmd)       UP_CMD="$2"; shift 2 ;;
    --verify-key)   VERIFY_KEY="$2"; shift 2 ;;
    --verify-ns)    VERIFY_NS="$2"; shift 2 ;;
    --yes)          APPLY=1; shift ;;
    -h|--help)      sed -n '2,32p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

say()   { printf '  %s\n' "$*"; }
head_() { printf '\n=== %s ===\n' "$*"; }
die()   { printf '\n  ✗ %s\n' "$*" >&2; exit 1; }

command -v docker >/dev/null || die "docker not found"
docker inspect "$CONTAINER" >/dev/null 2>&1 || die "no such container: $CONTAINER"

VOLUME="$(docker inspect "$CONTAINER" \
  --format '{{range .Mounts}}{{if eq .Destination "/app/.swarm"}}{{.Name}}{{end}}{{end}}')"
[ -n "$VOLUME" ] || die "no volume mounted at /app/.swarm in $CONTAINER"

head_ "Состояние"
say "контейнер: $CONTAINER   том: $VOLUME"
docker exec "$CONTAINER" ls -la /app/.swarm/ 2>/dev/null || true

# Оба файла обязаны существовать: memory.db — источник, agentdb-memory.db —
# приёмник со схемой, созданной новым образом. Если приёмника нет, значит новый
# образ ещё не запускался: переносить некуда, схемы нет.
for f in memory.db agentdb-memory.db; do
  docker run --rm -v "$VOLUME":/d "$SQLITE_IMAGE" test -f "/d/$f" \
    || die "в томе нет $f — сначала запустите новый образ (шаг 2), он создаёт agentdb-memory.db"
done

# SQL переносится файлом: экранировать кавычки через несколько уровней
# docker/ssh/heredoc — верный способ получить «no such column: active».
SQLFILE="$(mktemp)"
cat > "$SQLFILE" <<'SQL'
ATTACH '/d/memory.db' AS old;
SELECT 'источник (только активные):';
SELECT '  ' || namespace || ' -> ' || COUNT(*) FROM old.memory_entries
 WHERE status='active' OR status IS NULL GROUP BY namespace;
SELECT 'пропускаем (надгробия):';
SELECT '  ' || COALESCE(status,'(NULL)') || ' -> ' || COUNT(*) FROM old.memory_entries
 WHERE NOT (status='active' OR status IS NULL) GROUP BY status;
SQL

head_ "Что будет перенесено"
docker run --rm -i -v "$VOLUME":/d "$SQLITE_IMAGE" sh -c \
  'command -v sqlite3 >/dev/null 2>&1 || apk add --no-cache sqlite >/dev/null 2>&1;
   exec sqlite3 /d/agentdb-memory.db' < "$SQLFILE"

if [ "$APPLY" != 1 ]; then
  head_ "Только отчёт — ничего не изменено"
  say "Повторите с --yes, чтобы выполнить перенос (контейнер будет остановлен)."
  rm -f "$SQLFILE"; exit 0
fi

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_DIR="$BACKUP_ROOT/upgrade-$STAMP"
mkdir -p "$BACKUP_DIR"

head_ "Остановка $CONTAINER"
docker stop "$CONTAINER" >/dev/null
say "остановлен"

head_ "Бэкап тома (после остановки, поэтому консистентный) → $BACKUP_DIR"
docker run --rm -v "$VOLUME":/d -v "$BACKUP_DIR":/b "$SQLITE_IMAGE" \
  sh -c 'cd /d && tar cf /b/swarm-before-upgrade.tar .' || die "бэкап не удался"
ls -la "$BACKUP_DIR"

# Колонки берём явным списком: в боевой базе НЕТ provenance_type (он появился
# позже), поэтому `INSERT ... SELECT *` сломается. Приёмник подставит дефолт.
cat > "$SQLFILE" <<'SQL'
ATTACH '/d/memory.db' AS old;
INSERT OR REPLACE INTO memory_entries
  (id,key,namespace,content,type,embedding,embedding_model,embedding_dimensions,
   tags,metadata,owner_id,created_at,updated_at,expires_at,last_accessed_at,
   access_count,status)
SELECT id,key,namespace,content,type,embedding,embedding_model,embedding_dimensions,
   tags,metadata,owner_id,created_at,updated_at,expires_at,last_accessed_at,
   COALESCE(access_count,0),COALESCE(status,'active')
FROM old.memory_entries WHERE status='active' OR status IS NULL;
SELECT 'после переноса:';
SELECT '  ' || namespace || ' -> ' || COUNT(*) FROM memory_entries GROUP BY namespace;
PRAGMA integrity_check;
SQL

head_ "Перенос"
docker run --rm -i -v "$VOLUME":/d "$SQLITE_IMAGE" sh -c \
  'command -v sqlite3 >/dev/null 2>&1 || apk add --no-cache sqlite >/dev/null 2>&1;
   exec sqlite3 /d/agentdb-memory.db' < "$SQLFILE" \
  || { rm -f "$SQLFILE"; say "перенос НЕ удался; контейнер остановлен, бэкап в $BACKUP_DIR"; die "прерываю до старта"; }
rm -f "$SQLFILE"

head_ "Старт"
if [ -n "$UP_CMD" ]; then say "\$ $UP_CMD"; sh -c "$UP_CMD" >/dev/null || die "команда старта не сработала"; else docker start "$CONTAINER" >/dev/null; fi
for i in $(seq 1 45); do
  docker exec "$CONTAINER" curl -sf "http://127.0.0.1:${RUFLO_PORT:-3000}/health" >/dev/null 2>&1 && { say "healthy через ${i}s"; break; }
  sleep 1
  [ "$i" = 45 ] && say "ВНИМАНИЕ: /health не поднялся за 45s — смотрите docker logs $CONTAINER"
done

# Проверять надо ЧТЕНИЕМ ЧЕРЕЗ MCP, а не наличием строк в файле: весь смысл
# бага в том, что строки на месте, а путь до них разорван.
if [ -n "$VERIFY_KEY" ]; then
  head_ "Проверка чтения через MCP: $VERIFY_KEY"
  TOKEN="$(docker exec "$CONTAINER" printenv MCP_AUTH_TOKEN 2>/dev/null || true)"
  RESP="$(docker exec "$CONTAINER" sh -c "curl -s -m 60 -X POST http://127.0.0.1:${RUFLO_PORT:-3000}/mcp \
      -H 'Content-Type: application/json' -H 'Authorization: Bearer $TOKEN' \
      -d '{\"jsonrpc\":\"2.0\",\"method\":\"tools/call\",\"params\":{\"name\":\"memory_retrieve\",\"arguments\":{\"key\":\"$VERIFY_KEY\",\"namespace\":\"${VERIFY_NS:-default}\"}},\"id\":1}'" || true)"
  case "$RESP" in
    *'\"found\": false'*|*'"found": false'*) say "✗ ключ НЕ читается — миграция не достигла цели"; echo "$RESP" | head -c 300; exit 1 ;;
    '') say "✗ пустой ответ от MCP" ; exit 1 ;;
    *) say "✓ ключ читается через MCP" ;;
  esac
fi

head_ "Готово"
say "Бэкап до апгрейда: $BACKUP_DIR/swarm-before-upgrade.tar"
say "memory.db остаётся на месте как реликт: новые записи идут в agentdb-memory.db."
say "Откат теперь теряет всё, записанное после миграции — окно отката закрыто."
