# Deploy to Fly.io

This recipe deploys a Guren application to [Fly.io](https://fly.io) using the shared Docker image.

## Prerequisites

- [flyctl](https://fly.io/docs/flyctl/install/) installed and authenticated
- A Fly.io account
- A PostgreSQL database (Fly Postgres or external)

## Steps

### 1. Initialize the Fly app

From your project root, copy the `fly.toml` into place and launch:

```bash
cp deploy/fly/fly.toml ./fly.toml
fly launch --no-deploy
```

Edit `fly.toml` to set your desired app name and region.

### 2. Provision a database

Create a Fly Postgres cluster (or use an external provider):

```bash
fly postgres create --name my-guren-db
fly postgres attach my-guren-db
```

This automatically sets the `DATABASE_URL` secret on your app.

### 3. Set additional secrets

```bash
fly secrets set APP_KEY=$(openssl rand -hex 32)
```

Add any other secrets your application requires (mail credentials, S3 keys, etc.).

### 4. Deploy

```bash
fly deploy
```

### 5. Run database migrations

```bash
fly ssh console -C "bun run db:migrate"
```

### 6. Verify

```bash
fly status
fly logs
curl https://my-guren-app.fly.dev/health
```

## Scaling

```bash
# Scale to multiple instances
fly scale count 2

# Adjust VM size
fly scale vm shared-cpu-2x
```

## Custom domains

```bash
fly certs create example.com
```

Follow the DNS instructions printed by `flyctl` to point your domain at Fly.
