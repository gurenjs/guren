# Serverless Deployment (AWS Lambda)

Guren runs on AWS Lambda via the `@guren/core/lambda` adapter. This guide covers the full serverless stack — HTTP, queues, scheduled tasks, CLI commands, and infrastructure.

## Complete Lambda Entry Point

A single `lambda.ts` file can export handlers for every Lambda function:

```typescript
import app from './src/app'
import {
  createLambdaHandler,
  createSqsHandler,
  createScheduleHandler,
  createConsoleHandler,
} from '@guren/core/lambda'
import { scheduler } from './src/scheduler'
import { kernel } from './src/console'

await app.boot()

// HTTP requests via API Gateway / ALB
export const http = createLambdaHandler(app)

// SQS queue job processing
export const queue = createSqsHandler()

// EventBridge scheduled tasks
export const schedule = createScheduleHandler(scheduler)

// CLI commands (migrations, seeders, etc.)
export const console = createConsoleHandler(kernel)
```

`app.boot()` runs once during cold start. All handlers share the booted application instance.

## Handlers

### HTTP — `createLambdaHandler(app)`

Wraps the Hono fetch handler for API Gateway v1/v2 and ALB. Routes, controllers, and middleware work identically to the serverful configuration.

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

Executes CLI commands on Lambda. Invoke via AWS CLI:

```bash
aws lambda invoke --function-name my-app-console \
  --payload '{"command": "db:migrate"}' response.json
```

Returns `{ exitCode: 0 }` on success, `{ exitCode: 1 }` on failure.

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

The default `ScryptHasher` uses `Bun.password` — unavailable on Lambda's Node.js runtime. Use `NodeHasher` instead:

```typescript
import { NodeHasher } from '@guren/core'

// In your AuthProvider:
container.instance('hash', new NodeHasher())
```

> [!WARNING]
> `ScryptHasher` (Argon2/bcrypt via Bun) and `NodeHasher` (scrypt via Node.js) produce incompatible hash formats. Migrating an existing Bun-based app to Lambda requires rehashing passwords or a multi-format verifier.

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

Lambda is not suited for serving static files. Use CloudFront + S3:

1. Upload Vite build output (`public/assets/`) to an S3 bucket.
2. Create a CloudFront distribution pointing to that bucket.
3. Set `GUREN_INERTIA_ENTRY_URL` and `GUREN_INERTIA_STYLES_URL` to your CloudFront URLs.

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

### Storage & Filesystem

Lambda has a read-only filesystem except for `/tmp` (512 MB, ephemeral). Use `/tmp` only for transient cache. For persistent storage, use S3 via the `S3Driver`.

### Sessions & Cache

In-memory stores are lost between invocations, so sessions need a backend that survives across Lambda invocations.

For most apps, `DatabaseSessionStore` (from `@guren/core`) is the recommended default — it persists sessions in the same database your app already talks to (RDS Postgres, MySQL, or any Drizzle-supported dialect), so there's no extra infrastructure to provision:

```typescript
import { DatabaseSessionStore } from '@guren/core'
import { sessions } from '@/db/schema'

app.use(createSessionMiddleware({ store: new DatabaseSessionStore(sessions) }))
```

```typescript
// db/schema.ts
export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  data: text('data', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
})
```

Expired rows are treated as missing on read; call `store.deleteExpired()` from a scheduled task (e.g. via `createScheduleHandler`) to keep the table small.

For high-traffic apps that want to keep session churn off the primary database, use `RedisSessionStore` (ElastiCache) instead. Cache still benefits from Redis or DynamoDB — see the infrastructure table below.

## Infrastructure Recommendations

| Concern | Recommendation |
|---------|---------------|
| **HTTP trigger** | API Gateway v2 (HTTP API) or ALB |
| **Sessions** | `DatabaseSessionStore` (no extra infra) — or `RedisSessionStore` (ElastiCache) for high session churn |
| **Cache** | Redis via `RedisCacheStore` (`@guren/core/redis` ships session/rate-limit/API-token stores too), or `FileStore` with `/tmp` for ephemeral cache |
| **Queue** | SQS via `SqsDriver` + `createSqsHandler()` |
| **Database** | RDS PostgreSQL with RDS Proxy for connection pooling |
| **Scheduling** | EventBridge + `createScheduleHandler()` |
| **CLI commands** | Dedicated Lambda + `createConsoleHandler()` |
| **Static assets** | CloudFront + S3 |
| **Logging** | CloudWatch (stderr, JSON format) |

## AWS CDK Example

A complete CDK stack with all four Lambda functions:

```typescript
import { Duration, Stack } from 'aws-cdk-lib'
import * as lambda from 'aws-cdk-lib/aws-lambda'
import * as apigw from 'aws-cdk-lib/aws-apigatewayv2'
import * as sqs from 'aws-cdk-lib/aws-sqs'
import * as events from 'aws-cdk-lib/aws-events'
import * as targets from 'aws-cdk-lib/aws-events-targets'
import * as sqsEventSources from 'aws-cdk-lib/aws-lambda-event-sources'
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations'

const code = lambda.Code.fromAsset('dist')
const runtime = lambda.Runtime.NODEJS_22_X
const environment = {
  NODE_ENV: 'production',
  DATABASE_URL: '...',
  SQS_QUEUE_URL: '', // set below
}

// --- HTTP ---
const httpFn = new lambda.Function(this, 'Http', {
  runtime,
  handler: 'lambda.http',
  code,
  timeout: Duration.seconds(30),
  memorySize: 512,
  environment,
})

const api = new apigw.HttpApi(this, 'Api')
api.addRoutes({
  path: '/{proxy+}',
  integration: new HttpLambdaIntegration('HttpIntegration', httpFn),
})

// --- Queue ---
const queue = new sqs.Queue(this, 'JobQueue', {
  visibilityTimeout: Duration.seconds(60),
  deadLetterQueue: {
    queue: new sqs.Queue(this, 'JobDLQ'),
    maxReceiveCount: 3,
  },
})

environment.SQS_QUEUE_URL = queue.queueUrl

const queueFn = new lambda.Function(this, 'QueueWorker', {
  runtime,
  handler: 'lambda.queue',
  code,
  timeout: Duration.seconds(60),
  memorySize: 512,
  environment,
})

queueFn.addEventSource(
  new sqsEventSources.SqsEventSource(queue, {
    batchSize: 10,
    reportBatchItemFailures: true,
  }),
)

// --- Scheduler ---
const scheduleFn = new lambda.Function(this, 'Scheduler', {
  runtime,
  handler: 'lambda.schedule',
  code,
  timeout: Duration.seconds(60),
  memorySize: 256,
  environment,
})

new events.Rule(this, 'ScheduleRule', {
  schedule: events.Schedule.rate(Duration.minutes(1)),
  targets: [new targets.LambdaFunction(scheduleFn)],
})

// --- Console ---
const consoleFn = new lambda.Function(this, 'Console', {
  runtime,
  handler: 'lambda.console',
  code,
  timeout: Duration.minutes(5),
  memorySize: 512,
  environment,
})
```

> [!NOTE]
> Bundle your application with `esbuild` or `tsup` before deploying. Ensure all dependencies are included in the deployment package.

> [!WARNING]
> Disable identifier mangling in your bundler. Guren stores class names inside durable records — queued jobs carry the job's wire name, which defaults to its class name, persisted notifications carry their notification type, and HTTP exceptions report their own name — so a mangled build cannot resolve records written by the previous deploy. With `bun build`, use `--minify-whitespace --minify-syntax` instead of `--minify`. With `esbuild`, set `minifyIdentifiers: false`. With `tsup`, use `minifyWhitespace` and `minifySyntax` instead of `minify`. `--keep-names` / `keepNames` is not a substitute on Bun: as of Bun 1.3.14 the flag is accepted and class names stay mangled.
>
> If you must mangle, every job has to declare a `jobName` so its queue identity no longer depends on the class name — see [Pinning a Job's Wire Identity](./queue.md#pinning-a-jobs-wire-identity). That covers jobs only; notification types and exception names are still class-name derived, so leaving identifiers intact remains the safer default.
