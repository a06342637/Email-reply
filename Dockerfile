FROM node:22-bookworm-slim AS base
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates openssl \
    && rm -rf /var/lib/apt/lists/*

FROM base AS deps
COPY package.json package-lock.json* ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm ci

FROM deps AS builder
COPY . .
RUN npx prisma generate
RUN npm run build

FROM node:22-alpine AS updater
ARG APP_VERSION=0.11
ENV NODE_ENV=production \
    APP_VERSION=$APP_VERSION \
    DOCKER_CONFIG=/tmp/docker
LABEL org.opencontainers.image.title="MailPilot Updater" \
      org.opencontainers.image.version="$APP_VERSION" \
      org.opencontainers.image.source="https://github.com/a06342637/Email-reply"
RUN apk add --no-cache bash ca-certificates curl git docker-cli docker-cli-buildx docker-cli-compose
WORKDIR /updater
COPY --from=builder /app/apps/api/dist ./dist
USER root
EXPOSE 3001
CMD ["node", "/updater/dist/updater.js"]

FROM deps AS prod-deps
RUN npm ci --omit=dev --workspaces --include-workspace-root

FROM base AS runtime
ARG APP_VERSION=0.11
ENV NODE_ENV=production
LABEL org.opencontainers.image.title="MailPilot" \
      org.opencontainers.image.version="$APP_VERSION" \
      org.opencontainers.image.source="https://github.com/a06342637/Email-reply"
WORKDIR /app
RUN groupadd --gid 10001 autoreply && useradd --uid 10001 --gid autoreply --shell /usr/sbin/nologin --create-home autoreply
COPY --from=prod-deps --chown=autoreply:autoreply /app/node_modules ./node_modules
COPY --from=prod-deps --chown=autoreply:autoreply /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=builder --chown=autoreply:autoreply /app/node_modules/@prisma/client ./node_modules/@prisma/client
COPY --from=builder --chown=autoreply:autoreply /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder --chown=autoreply:autoreply /app/apps/api/dist ./apps/api/dist
COPY --from=builder --chown=autoreply:autoreply /app/apps/api/package.json ./apps/api/package.json
COPY --from=builder --chown=autoreply:autoreply /app/apps/web/dist ./apps/web/dist
COPY --from=builder --chown=autoreply:autoreply /app/prisma ./prisma
COPY --from=builder --chown=autoreply:autoreply /app/package.json ./package.json
COPY --from=builder --chown=autoreply:autoreply /app/scripts/autoreply /usr/local/bin/autoreply
RUN chmod 0755 /usr/local/bin/autoreply
USER autoreply
EXPOSE 3000
CMD ["node", "apps/api/dist/main.js"]

FROM deps AS migration
COPY prisma ./prisma
RUN npx prisma generate
USER node
CMD ["npx", "prisma", "migrate", "deploy"]
