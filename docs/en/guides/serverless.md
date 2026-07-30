# Serverless Deployment (AWS Lambda)

Guren runs on AWS Lambda's Node.js runtime. The official `@guren/plugin-lambda` plugin handles bundling, and a CDK construct provisions the full stack — HTTP, queues, scheduled tasks, CLI commands, and static assets.

## Setup

```bash
bunx guren plugin @guren/plugin-lambda
bun add @guren/plugin-lambda
```

Installing registers `lambdaPlugin()` in `src/app.ts` and scaffolds `src/lambda.ts` — the module whose exports become your Lambda handlers:

```typescript
// src/lambda.ts (scaffolded)
import app from './app.js'
import { createLambdaHandler, createSqsHandler } from '@guren/core/lambda'

// Boots once at cold start; every handler shares the booted application.
await app.boot()

// HTTP requests via API Gateway, ALB, or a Lambda Function URL.
export const http = createLambdaHandler(app)

// SQS queue job processing (wire an SQS event source to this handler).
export const queue = createSqsHandler()
```

Uncomment the `schedule` and `console` exports in the scaffold once your app defines a scheduler or console kernel.

## Build

```bash
bunx guren lambda:build
```

The command runs your app's `build` script, then assembles a `.lambda/` directory:

| Path | Contents |
|------|----------|
| `function/` | Self-contained ESM bundle (`handler.js`) plus the SSR bundle and Drizzle migrations — deploy this as the function code |
| `assets/` | `public/` staged for S3, with built assets mirrored under both `/assets/` and `/public/assets/` |
| `env.json` | The environment the function expects — the same values are baked into the bundle as defaults |

Handler identifiers follow the bundle: `handler.http`, `handler.queue`, `handler.schedule`, `handler.console`.

`process.env.NODE_ENV` is pinned to `"production"` at bundle time — the bundler inlines it, so runtime configuration alone cannot fix a development-mode bundle. Inertia asset locations (`GUREN_INERTIA_ENTRY`, `GUREN_INERTIA_STYLES`, and the SSR entry) are baked in as defaults too; real function environment variables still override them.

Pass `--zip` to also produce `function.zip` for direct uploads. CDK archives the directory on its own.

## Handlers

### HTTP — `createLambdaHandler(app)`

Wraps the app's fetch handler for API Gateway v1/v2 and ALB. Routes, controllers, and middleware work identically to the serverful configuration.

### Queue — `createSqsHandler()`

Processes SQS messages as Guren jobs. Supports **partial batch failure** — only failed messages are returned to SQS for retry.

Configure the SQS driver in your queue provider:

```typescript
import { SQSClient } from '@aws-sdk/client-sqs'
import { createSqsAdapter, SqsDriver, setQueueDriver } from '@guren/core'

const adapter = createSqsAdapter(new SQSClient({ region: 'ap-northeast-1' }))
setQueueDriver(new SqsDriver(adapter, {
  queueUrl: process.env.SQS_QUEUE_URL!,
  // Optional: map logical queue names to separate SQS URLs
  queueUrls: {
    emails: process.env.SQS_EMAILS_QUEUE_URL!,
  },
}))
```

Jobs are dispatched the same way as on the server — `await SendEmailJob.dispatch({ to: 'user@example.com' })`. The `SqsDriver` serializes the job to SQS, and the Lambda handler deserializes and executes it.

### Schedule — `createScheduleHandler(scheduler)`

Runs due tasks when invoked by EventBridge. Configure an EventBridge rule with `rate(1 minute)` to trigger this handler. The existing `Scheduler` and task definitions work without changes.

### Console — `createConsoleHandler(kernel)`

Executes commands registered on your app's `ConsoleKernel`. The kernel has no built-in commands — the scaffolded `src/lambda.ts` ships a commented-out example that registers `db:migrate`; uncomment it (and the `console` export) to enable the handler:

```typescript
import { Command, ConsoleKernel } from '@guren/core'
import { migrateDatabase } from '../config/database.js'

class MigrateCommand extends Command {
  static signature = 'db:migrate'
  static description = 'Apply pending database migrations'
  async handle(): Promise<void> {
    await migrateDatabase()
  }
}

const kernel = new ConsoleKernel()
kernel.register(MigrateCommand)
```

Invoke via AWS CLI:

```bash
aws lambda invoke --function-name my-app-console \
  --cli-binary-format raw-in-base64-out \
  --payload '{"command": "db:migrate"}' response.json
```

Returns `{ exitCode: 0 }` on success, `{ exitCode: 1 }` on failure.

## Server-Side Rendering

SSR works on Lambda without extra configuration. `lambda:build` copies the Vite SSR bundle into the function directory and bakes its location into the bundle; the server loads the renderer on the first Inertia render. Apps without an SSR build produce a CSR-only function — no flag needed either way.

## Database

### Aurora Serverless v2 with the RDS Data API (recommended)

The Data API is HTTP-based: no connection pool, no RDS Proxy, and the function does not need to run inside a VPC. Use `createAwsDataApiDatabase`:

```typescript
// config/database.ts
import { createAwsDataApiDatabase } from '@guren/core'

const database = createAwsDataApiDatabase({
  migrationsFolder: new URL('../db/migrations', import.meta.url),
  seedersFolder: new URL('../db/seeders', import.meta.url),
  // Falls back to DATABASE_NAME / DATABASE_RESOURCE_ARN / DATABASE_SECRET_ARN
})

export const { getDatabase, migrateDatabase, closeDatabase, configureOrm, seedDatabase } = database
```

Install the driver alongside it (`bun add @aws-sdk/client-rds-data`). The function needs the `rds-data` actions on the cluster plus `secretsmanager:GetSecretValue` on the secret — the CDK construct's `dataApi` option (below) wires both, and authentication uses the function's IAM role. For `drizzle-kit generate`/`push`, set `driver: 'aws-data-api'` in `drizzle.config.ts`.

See the [Database Guide](./database.md) for the full factory reference.

### Classic RDS with RDS Proxy

`createPostgresDatabase` works against RDS when the function runs inside the VPC. Route connections through RDS Proxy and disable prepared statements — they pin proxy sessions:

```typescript
const database = createPostgresDatabase({
  migrationsFolder: new URL('../db/migrations', import.meta.url),
  connectionString: () => process.env.DATABASE_URL,
  clientOptions: { prepare: false, max: 1 },
})
```

## Runtime Detection

Conditionally configure services based on the runtime:

```typescript
import { isLambda, getLambdaContext } from '@guren/core/lambda'

if (isLambda()) {
  const ctx = getLambdaContext()!
  // ctx.functionName — Lambda function name
  // ctx.region       — AWS region
  // ctx.memorySize   — allocated memory (MB)
  // ctx.tmpDir       — writable temp directory (/tmp)
  // ctx.logGroup     — CloudWatch log group
}
```

## Password Hashing

The default hasher detects the runtime: Bun's scrypt locally, Node's `crypto.scrypt` (`NodeHasher`) on Lambda. No configuration is needed for new apps.

> [!WARNING]
> The two implementations produce incompatible hash formats. Migrating an existing Bun-hosted app with stored password hashes to Lambda requires rehashing passwords or a multi-format verifier.

## Logging

Lambda captures `stderr` to CloudWatch automatically. Use JSON-formatted console logging:

```typescript
import { LogManager } from '@guren/core'

const log = new LogManager({
  default: 'console',
  channels: {
    console: { driver: 'console', level: 'info', format: 'json', colors: false },
  },
})
```

## Static Assets

Lambda is not suited for serving static files. `lambda:build` stages `public/` into `.lambda/assets`, ready for S3, and the CDK construct (below) provisions the bucket and a CloudFront distribution that routes `/assets/*` and `/public/*` to it, with the app as the default origin.

Deploying assets by hand instead? Sync `.lambda/assets` to a bucket and set `GUREN_INERTIA_ENTRY` / `GUREN_INERTIA_STYLES` on the function to the CDN URLs (the values are listed in `.lambda/env.json`).

## Configuration Notes

### Service Providers

Auto-discovery (`Bun.Glob`) is not available on Lambda. List all providers explicitly:

```typescript
const app = createApp({
  providers: [
    DatabaseProvider,
    AuthProvider,
    CacheProvider,
    // ... all providers
  ],
  routes: registerRoutes,
})
```

### Migrations & Seeding

The scaffolded `config/app.ts` seeds the database on boot as a local development convenience and skips it when `NODE_ENV=production`. Keep that guard — Lambda boots the app on every cold start, so boot-time seeding would re-run against production data.

**Migrations** ship with the function: `lambda:build` copies `db/migrations/` next to the bundle, so the scaffold's `db:migrate` console command can apply them in place once you uncomment it. See [Console — `createConsoleHandler(kernel)`](#console--createconsolehandlerkernel) for the command definition and how to invoke it.

**Seeders cannot run inside the function.** They are ordinary `.ts` modules that import your schema and `@guren/core`, and the deployed function is a self-contained bundle with no `node_modules` and no TypeScript loader — the Node.js runtime rejects them outright. Seed from somewhere that has the project source instead:

```bash
DATABASE_URL='<production connection string>' bunx guren db:seed --force
```

If a dataset must ship with the release rather than be applied by hand, express it as a migration so it travels with the function.

### Storage & Filesystem

Lambda has a read-only filesystem except for `/tmp` (512 MB, ephemeral). Use `/tmp` only for transient cache. For persistent storage, use S3 via the `S3Driver`.

### Sessions & Cache

In-memory stores are lost between invocations, so sessions need a backend that survives across Lambda invocations.

For most apps, `DatabaseSessionStore` (from `@guren/core`) is the recommended default — it persists sessions in the same database your app already talks to, so there's no extra infrastructure to provision:

```typescript
import { DatabaseSessionStore } from '@guren/core'
import { sessions } from '@/db/schema'

app.use(createSessionMiddleware({ store: new DatabaseSessionStore(sessions) }))
```

Expired rows are treated as missing on read; call `store.deleteExpired()` from a scheduled task (e.g. via `createScheduleHandler`) to keep the table small.

For high-traffic apps that want to keep session churn off the primary database, use `RedisSessionStore` (ElastiCache) instead. Cache still benefits from Redis or DynamoDB — see the infrastructure table below.

## Infrastructure Recommendations

| Concern | Recommendation |
|---------|---------------|
| **HTTP trigger** | API Gateway v2 (HTTP API) or ALB |
| **Database** | Aurora Serverless v2 + Data API via `createAwsDataApiDatabase` — or RDS + RDS Proxy |
| **Sessions** | `DatabaseSessionStore` (no extra infra) — or `RedisSessionStore` (ElastiCache) for high session churn |
| **Cache** | Redis via `RedisCacheStore` (`@guren/core/redis` ships session/rate-limit/API-token stores too), or `FileStore` with `/tmp` for ephemeral cache |
| **Queue** | SQS via `SqsDriver` + `createSqsHandler()` |
| **Scheduling** | EventBridge + `createScheduleHandler()` |
| **CLI commands** | Dedicated Lambda + `createConsoleHandler()` |
| **Static assets** | CloudFront + S3 (provisioned by the CDK construct) |
| **Logging** | CloudWatch (stderr, JSON format) |

## Deploy with CDK

The plugin ships a CDK construct that wires the whole topology — the HTTP API, queue worker with dead-letter queue and partial batch failures, EventBridge rule, console function, and CloudFront + S3 for assets:

```bash
bun add aws-cdk-lib constructs
```

```typescript
import { App, Stack } from 'aws-cdk-lib'
import { GurenLambdaApp } from '@guren/plugin-lambda/cdk'

const app = new App()
const stack = new Stack(app, 'MyApp')

new GurenLambdaApp(stack, 'App', {
  functionDir: '../.lambda/function',
  assets: { dir: '../.lambda/assets' },
  queue: {},        // SQS + worker (omit if the app dispatches no jobs)
  schedule: {},     // EventBridge rule, every minute (needs the schedule export)
  console: true,    // db:migrate & friends via `aws lambda invoke`
  // Wires DATABASE_* environment plus the rds-data and secret-read grants
  // onto every function.
  dataApi: {
    database: 'appdb',
    resourceArn: process.env.DATABASE_RESOURCE_ARN!,
    secretArn: process.env.DATABASE_SECRET_ARN!,
  },
  environment: {
    APP_KEY: process.env.APP_KEY!,
  },
})
```

Every sub-resource is exposed as a property (`httpFunction`, `queue`, `distribution`, ...) for further customization — attaching a custom domain, adding IAM grants, tuning memory per function. A complete, deployable CDK app lives in the [deploy recipes](https://github.com/gurenjs/guren/tree/main/examples/deploy/serverless).

```bash
bunx guren lambda:build
bunx cdk deploy
```

> [!WARNING]
> If you replace `lambda:build` with your own bundler, disable identifier mangling. Guren stores class names inside durable records — queued jobs carry the job's wire name, which defaults to its class name, persisted notifications carry their notification type, and HTTP exceptions report their own name — so a mangled build cannot resolve records written by the previous deploy. With `bun build`, use `--minify-whitespace --minify-syntax` instead of `--minify`. With `esbuild`, set `minifyIdentifiers: false`. With `tsup`, use `minifyWhitespace` and `minifySyntax` instead of `minify`. `--keep-names` / `keepNames` is not a substitute on Bun: as of Bun 1.3.14 the flag is accepted and class names stay mangled. `lambda:build` already does this for you.
>
> If you must mangle, every job has to declare a `jobName` and every notification an explicit `type`, so their durable identities no longer depend on class names — see [Pinning a Job's Wire Identity](./queue.md#pinning-a-jobs-wire-identity). Both default to the class name when not declared, and exception names are always class-name derived, so leaving identifiers intact remains the safer default.
