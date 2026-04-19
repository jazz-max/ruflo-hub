FROM node:22-alpine

RUN apk add --no-cache curl bash postgresql-client tar gzip

RUN npm install -g ruflo@latest pg

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
