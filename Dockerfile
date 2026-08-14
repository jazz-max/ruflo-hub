FROM node:22-alpine

RUN apk add --no-cache curl bash postgresql-client tar gzip

# ruflo is PINNED deliberately. Unpinned (`ruflo@latest`) the weekly CI rebuild
# means any container recreate silently jumps versions — and 3.15+ added the
# #2735 gate that REFUSES every memory operation while `-wal`/`-shm` sidecars sit
# next to memory.db (they do on a live install, see MEMORY-DB-BLOAT-INVESTIGATION.md).
# An unplanned recreate would therefore take memory down completely.
# 3.14.2 is the version production has been running; upgrade as a deliberate step
# AFTER the WAL checkpoint + namespace cleanup, not as a side effect of a rebuild.
ARG RUFLO_VERSION=3.14.2
RUN npm install -g ruflo@${RUFLO_VERSION} pg

# Build-time patch for the upstream claude-flow memory leak: cache sql.js backends
# per path so createDatabase() stops re-loading the full memory.db into a new
# sql.js Database per call (each leaks an N-MB dbfile_* in the Emscripten MEMFS).
# Best-effort + idempotent; if upstream changes the file it warns and the RSS
# watchdog in server.mjs still contains the leak. See UPSTREAM-ISSUE-sqljs-memfs-leak.md.
COPY scripts/patch-sqljs-leak.cjs /tmp/patch-sqljs-leak.cjs
RUN node /tmp/patch-sqljs-leak.cjs

# Pre-bake the ONNX embeddings model (all-MiniLM-L6-v2, ~90MB) into the image so the
# container starts WITHOUT a runtime HuggingFace download. A fresh/recreated container
# otherwise re-downloads it on startup; on a flaky network it can't finish within the
# 60s MCP connect timeout → server.mjs crash-loops indefinitely. Baking it = instant,
# recreate-safe startup. The model caches under /root/.ruvector/models (HOME-based).
RUN cd /tmp && timeout 360 sh -c \
      'ruflo mcp start </dev/null >/tmp/warm.log 2>&1 & \
       until [ -f /root/.ruvector/models/all-MiniLM-L6-v2/model.onnx ]; do sleep 2; done' ; \
    test -f /root/.ruvector/models/all-MiniLM-L6-v2/model.onnx \
      || { echo "MODEL BAKE FAILED — warm log:"; tail -20 /tmp/warm.log; exit 1; }

ENV RUFLO_PORT=3000
ENV POSTGRES_HOST=localhost
ENV POSTGRES_PORT=5432
ENV POSTGRES_DB=ruflo
ENV POSTGRES_USER=ruflo
ENV POSTGRES_PASSWORD=ruflo

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY server.mjs ./
COPY templates/ ./templates/
COPY .claude/skills/   ./skills-bundle/skills/
COPY .claude/agents/   ./skills-bundle/agents/
COPY .claude/commands/ ./skills-bundle/commands/
COPY scripts/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE ${RUFLO_PORT}

HEALTHCHECK --interval=10s --timeout=3s --start-period=30s --retries=3 \
  CMD curl -sf http://127.0.0.1:${RUFLO_PORT}/health || exit 1

ENTRYPOINT ["/entrypoint.sh"]
