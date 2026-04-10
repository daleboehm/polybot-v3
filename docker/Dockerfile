FROM node:22-alpine AS builder

WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile

COPY tsconfig.json ./
COPY src/ ./src/
RUN pnpm build

FROM node:22-alpine AS runtime

RUN apk add --no-cache tini

WORKDIR /opt/polybot-v3

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./
COPY config/ ./config/

# Data directory for SQLite
RUN mkdir -p /opt/polybot-v3/data

# Entity state directories are mounted as volumes
VOLUME ["/opt/polybot-v3/data"]

ENV NODE_ENV=production
ENV NODE_OPTIONS="--max-old-space-size=512"

EXPOSE 9100

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]
