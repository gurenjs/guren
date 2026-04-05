# Deploy to Production

This guide covers the essential steps to take a Guren application from local development to a production environment. It focuses on Docker-based deployment with Bun.

> [!NOTE]
> For serverless deployment on AWS Lambda, see the [Serverless Guide](./serverless.md). For the full deployment reference, see [Deployment](./deployment.md).

## Pre-Deploy Checklist

Run these commands before every deployment to catch issues early:

```bash
# Build frontend and backend
bun run build

# Type check the entire project
bun run typecheck

# Run the full test suite
bun run test

# Validate route, controller, and page consistency
bunx guren doctor
```

Fix any errors before proceeding. The `doctor` command catches mismatches between routes, controllers, and pages that could cause runtime failures.

## 1. Configure Environment Variables

Your production environment needs these variables at minimum:

| Variable | Example | Purpose |
|----------|---------|---------|
| `APP_URL` | `https://example.com` | Public-facing URL |
| `APP_ENV` | `production` | Enables production optimizations |
| `PORT` | `3333` | Server listen port |
| `DATABASE_URL` | `postgres://user:pass@host:5432/db` | Postgres connection string |
| `SESSION_SECRET` | *(random 64-char string)* | Signs session cookies |

> [!WARNING]
> Never commit secrets to git. Use your platform's secret manager or inject variables at deploy time.

Generate a session secret with:

```bash
openssl rand -hex 32
```

## 2. Write a Dockerfile

Create a `Dockerfile` in your project root:

```dockerfile
FROM oven/bun:1 AS base
WORKDIR /app

# Install dependencies
FROM base AS deps
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# Build the application
FROM base AS build
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

# Production image
FROM base AS production
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public
COPY --from=build /app/package.json ./

ENV APP_ENV=production
ENV PORT=3333
EXPOSE 3333

CMD ["bun", "run", "start"]
```

Build and test locally:

```bash
docker build -t my-app .
docker run -p 3333:3333 --env-file .env.production my-app
```

## 3. Run Database Migrations

Run migrations as part of your deployment pipeline, not inside the Dockerfile. This avoids running migrations on every container start:

```bash
# In your CI/CD pipeline or deployment script
bunx guren db:migrate --force
```

The `--force` flag suppresses the confirmation prompt in production.

## 4. Set Up a Health Check

Add a health check endpoint to your routes so load balancers and container orchestrators can verify your app is running:

```typescript
import { Router } from '@guren/core'

export function registerWebRoutes(router: Router): void {
  router.get('/health', (c) => {
    return c.json({ status: 'ok' })
  })

  // ... your other routes
}
```

For a more thorough check that also verifies the database connection, use the built-in health check system. See [Health Checks](./health-checks.md) for details.

## 5. Configure Docker Compose for Production

For single-server deployments, a `docker-compose.production.yml` keeps things manageable:

```yaml
services:
  app:
    build: .
    ports:
      - "3333:3333"
    env_file: .env.production
    restart: unless-stopped
    depends_on:
      postgres:
        condition: service_healthy
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3333/health"]
      interval: 30s
      timeout: 5s
      retries: 3

  postgres:
    image: postgres:17
    volumes:
      - pgdata:/var/lib/postgresql/data
    environment:
      POSTGRES_USER: ${DB_USER}
      POSTGRES_PASSWORD: ${DB_PASSWORD}
      POSTGRES_DB: ${DB_NAME}
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${DB_USER}"]
      interval: 10s
      timeout: 5s
      retries: 5

volumes:
  pgdata:
```

Deploy with:

```bash
docker compose -f docker-compose.production.yml up -d
```

## 6. Post-Deploy Verification

After deployment, verify everything is working:

```bash
# Check the health endpoint
curl https://example.com/health
# Expected: {"status":"ok"}

# Verify a page loads
curl -I https://example.com
# Expected: HTTP/2 200

# Check logs for errors
docker compose -f docker-compose.production.yml logs app --tail 50
```

## Production Hardening

Once your app is deployed and running, consider these additional steps:

- **Reverse proxy** — place Nginx or Caddy in front of Bun for TLS termination and static asset serving
- **Process monitoring** — use `restart: unless-stopped` in Docker or a process manager like systemd
- **Logging** — configure structured logging and ship logs to a centralized service
- **Backups** — schedule regular Postgres backups with `pg_dump` or a managed database service

## Next Steps

- [Serverless Guide](./serverless.md) — deploy to AWS Lambda
- [Operations](./operations.md) — monitoring, scaling, and maintenance
- [Health Checks](./health-checks.md) — advanced health check configuration
