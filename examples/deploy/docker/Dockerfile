# Build stage
FROM oven/bun:1.3 AS builder
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production=false

COPY . .
RUN bun run codegen && bun run build

# Production stage
FROM oven/bun:1.3-slim
WORKDIR /app

COPY --from=builder /app/package.json /app/bun.lock ./
RUN bun install --frozen-lockfile --production

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/public ./public
COPY --from=builder /app/db ./db
COPY --from=builder /app/.guren ./.guren

ENV NODE_ENV=production
ENV PORT=3333
EXPOSE 3333

HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD curl -f http://localhost:3333/health || exit 1

CMD ["bun", "run", "start"]
