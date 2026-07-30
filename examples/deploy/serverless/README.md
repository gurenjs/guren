# Deploy to AWS Lambda

Deploy a Guren application to AWS Lambda on the Node.js runtime with the official `@guren/plugin-lambda` plugin. The plugin bundles the app; the bundled CDK construct provisions the stack — HTTP API, SQS worker, EventBridge scheduler, console function, and CloudFront + S3 for assets.

## Prerequisites

- An AWS account and credentials configured locally (`aws configure` or SSO)
- The AWS CDK bootstrapped in the target account/region (`bunx cdk bootstrap`, once)
- A Guren app with `src/app.ts`

## Steps

### 1. Install the plugin

```bash
bunx guren plugin @guren/plugin-lambda
bun add @guren/plugin-lambda
```

This registers `lambdaPlugin()`, scaffolds `src/lambda.ts` (whose exports become the Lambda handlers), and ignores `.lambda`. The plugin also contributes the `lambda:build` command to the `guren` CLI.

### 2. Point the database at the RDS Data API

Create an Aurora Serverless v2 cluster with the Data API enabled, then switch `config/database.ts` to `createAwsDataApiDatabase`:

```typescript
import { createAwsDataApiDatabase } from '@guren/core'

const database = createAwsDataApiDatabase({
  migrationsFolder: new URL('../db/migrations', import.meta.url),
  seedersFolder: new URL('../db/seeders', import.meta.url),
  // Reads DATABASE_NAME / DATABASE_RESOURCE_ARN / DATABASE_SECRET_ARN
})
```

```bash
bun add @aws-sdk/client-rds-data
```

> [!IMPORTANT]
> Sessions must survive across invocations — in-memory stores silently log every user out on the next cold start. Use `DatabaseSessionStore` (see the [Serverless Guide](../../../docs/en/guides/serverless.md)).

### 3. Build

```bash
bunx guren lambda:build
```

Produces `.lambda/function` (the code bundle), `.lambda/assets` (S3 staging), and `.lambda/env.json`. Rebuild before every deploy — the output is generated, not committed.

### 4. Deploy the stack

Copy the `cdk/` directory from this recipe next to your app, then:

```bash
cd cdk
bun install
bunx cdk deploy
```

The stack outputs the CloudFront URL (serve traffic from here) and the raw API endpoint.

### 5. Run migrations

Register a `db:migrate` command in `src/console.ts` (see the [serverless guide](../../../docs/en/guides/serverless.md)), uncomment the `console` export in `src/lambda.ts` before building, then invoke it inside the deployed environment:

```bash
aws lambda invoke --function-name <stack>-Console... \
  --cli-binary-format raw-in-base64-out \
  --payload '{"command": "db:migrate"}' response.json
```

> [!WARNING]
> The HTTP function serves requests as soon as the stack is up — before migrations have run. Deploy, migrate, then route traffic (or ship migrations in the same release pipeline step).

## What Must Be Different on Lambda

| Concern | Why |
|---------|-----|
| Database via Data API | Lambda's connection churn exhausts classic Postgres pools; the Data API is HTTP and needs no pool or VPC |
| Sessions in the database or Redis | In-memory state is lost between invocations |
| Password hashing via Node scrypt | `Bun.password` does not exist on the Node.js runtime — the default hasher detects this automatically |
| Assets on S3 + CloudFront | The function ships no static file serving; asset URLs are baked into the bundle as same-origin defaults |
| Providers listed explicitly | Provider auto-discovery requires Bun's glob APIs |

## Container-Based Alternatives

If you want serverless scaling with the full Bun runtime instead of Lambda's Node.js runtime, deploy the standard Docker image to ECS Fargate, Cloud Run, or Fly Machines — see the [docker](../docker/) and [fly](../fly/) recipes. Every Guren feature works there without adaptation.

Full guide: [Serverless Deployment Guide](../../../docs/en/guides/serverless.md)
