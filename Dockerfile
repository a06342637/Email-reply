FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm ci

FROM deps AS builder
COPY . .
RUN npx prisma generate
RUN npm run build
RUN npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
ARG APP_VERSION=0.01
ENV NODE_ENV=production
LABEL org.opencontainers.image.title="MailPilot" \
      org.opencontainers.image.version="$APP_VERSION" \
      org.opencontainers.image.source="https://github.com/a06342637/Email-reply"
WORKDIR /app
RUN groupadd --gid 10001 autoreply && useradd --uid 10001 --gid autoreply --shell /usr/sbin/nologin --create-home autoreply
COPY --from=builder --chown=autoreply:autoreply /app/node_modules ./node_modules
COPY --from=builder --chown=autoreply:autoreply /app/apps/api/node_modules ./apps/api/node_modules
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
