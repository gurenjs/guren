# Build stage — includes devDependencies for Vite/TypeScript
FROM oven/bun:1.4.4@sha256:1d22548f177f4ff38e0c15baa3c2c46c6c2060ba2d1bc573bb4720b407548f1d AS builder
WORKDIR /app

COPY bun.lock package.json ./
RUN bun install --frozen-lockfile

COPY . .
RUN bun run build
# COPY fails on a missing source, and not every app has every runtime
# directory (an API-only app has no public/, lang/ or .guren/).
RUN mkdir -p bin src app config routes modules db lang public .guren

# Production stage — runtime only
FROM oven/bun:1.4.4-slim@sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4
WORKDIR /app

COPY --from=builder /app/package.json /app/bun.lock ./
RUN bun install --frozen-lockfile --production

COPY --from=builder /app/tsconfig.json ./tsconfig.json
COPY --from=builder /app/bin ./bin
COPY --from=builder /app/src ./src
COPY --from=builder /app/app ./app
COPY --from=builder /app/config ./config
COPY --from=builder /app/routes ./routes
COPY --from=builder /app/modules ./modules
COPY --from=builder /app/db ./db
COPY --from=builder /app/lang ./lang
COPY --from=builder /app/public ./public
COPY --from=builder /app/.guren ./.guren

EXPOSE 3333
ENV NODE_ENV=production
CMD ["bun", "bin/serve.ts"]
