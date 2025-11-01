# Deployment Guide

This guide summarizes the steps required to promote a freshly scaffolded Guren application to production. It assumes you generated your project with `create-guren-app` and that you have a PostgreSQL instance available.

## Production Checklist
- Configure environment variables (`DATABASE_URL`, `APP_URL`, `PORT`, etc.).
- Install dependencies with Bun in production mode.
- Build frontend assets.
- Run database migrations (and seed data if necessary).
- Start the Bun server behind a process manager or container runtime.

## 1. Prepare Environment Variables
Create a production-specific `.env` (or inject variables through your hosting platform). At minimum configure:

```dotenv
APP_URL=https://example.com
PORT=3333
DATABASE_URL=postgres://user:password@db-host:5432/database
NODE_ENV=production
```

Avoid committing this file—use your platform’s secret manager instead.

## 2. Install Dependencies
On the deployment host:

```bash
bun install --production
```

This installs only the dependencies required at runtime. If your environment builds assets during deployment, you can omit `--production` to keep dev tooling available.

## 3. Build Frontend Assets

```bash
NODE_ENV=production bun run build
```

The scaffolded build script bundles `resources/js/app.tsx` into `public/assets/`, ready to serve to browsers.

## 4. Run Database Migrations (and Seeders)

```bash
NODE_ENV=production bun run db:migrate
# Optional
bun run db:seed
```

Run these commands on every deployment to keep the schema in sync. Seeders are optional and typically used for demo or staging data.

## 5. Start the Server
You can start the Bun server directly:

```bash
NODE_ENV=production bun run bin/serve.ts
```

For reliability, wrap this command with a process manager (e.g. `systemd`, `pm2`, `supervisord`, or your hosting provider’s run command). Example `systemd` unit:

```ini
[Unit]
Description=Guren Application
After=network.target

[Service]
EnvironmentFile=/etc/guren/my-app.env
WorkingDirectory=/var/www/my-app
ExecStart=/usr/local/bin/bun run bin/serve.ts
Restart=always

[Install]
WantedBy=multi-user.target
```

Reload systemd, enable the service, and start it with `sudo systemctl enable --now my-app`.

## Container Deployment Example

```dockerfile
FROM oven/bun:1 AS base
WORKDIR /app

COPY bun.lock package.json ./
RUN bun install --production

COPY . .
RUN NODE_ENV=production bun run build

EXPOSE 3333
ENV NODE_ENV=production
CMD ["bun", "run", "bin/serve.ts"]
```

Build and run:

```bash
docker build -t my-app .
docker run --env-file .env.prod -p 3333:3333 my-app
```

Mount your configuration or secrets as needed for your hosting environment.

## Post-Deployment Tasks
- Set up HTTPS (e.g. via a reverse proxy such as Nginx, Caddy, or your cloud platform).
- Configure logging and monitoring—Bun prints to stdout/stderr, so ship logs to your chosen aggregator.
- Schedule automated backups for the PostgreSQL database.
- Implement health checks (e.g. expose `/health` route via `Route.get('/health', (ctx) => ctx.json({ ok: true }))`) and wire them into your load balancer.

Following this checklist ensures each release is reproducible, migrates the database safely, and keeps your application responsive in production.
