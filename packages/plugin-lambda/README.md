# @guren/plugin-lambda

Deploy a [Guren](https://guren.dev/) application to AWS Lambda on the Node.js runtime.

```bash
bunx guren plugin @guren/plugin-lambda
bun add @guren/plugin-lambda
```

Installing registers a `lambda:build` command and scaffolds `src/lambda.ts` — the module whose exports become your Lambda handlers.

## Build and deploy

```bash
bunx guren lambda:build
```

`lambda:build` runs the deploy-runtime checks `guren doctor` reports (a warning, never a failure, on an in-memory session or OAuth store, a `ScryptHasher`, or filesystem provider discovery), then your app's `build` script, then assembles a `.lambda/` directory:

| Path | Contents |
|------|----------|
| `function/` | Self-contained ESM bundle (`handler.js`) plus the SSR bundle and Drizzle migrations — deploy this as the function code (handlers: `handler.http`, `handler.queue`, ...) |
| `assets/` | `public/` staged for S3, with built assets mirrored under both `/assets/` and `/public/assets/` |
| `env.json` | Environment the function expects (`NODE_ENV`, Inertia asset entries) — the same values are baked into the bundle as defaults |

It is generated output — add `.lambda` to `.gitignore` (the installer does this) and rebuild before every deploy. Pass `--zip` to also produce `function.zip` for direct uploads; CDK's `Code.fromAsset('.lambda/function')` archives the directory on its own.

## API

- **`buildLambdaOutput(options)`** — the function behind `lambda:build`; import it for custom build scripts.
- **`lambdaPlugin()`** — the service provider factory, registered automatically by `guren plugin`.

The runtime adapters live in the framework itself — `createLambdaHandler`, `createSqsHandler`, `createScheduleHandler`, and `createConsoleHandler` from `@guren/core/lambda`.

## Infrastructure (CDK)

The `@guren/plugin-lambda/cdk` subpath ships a construct that provisions the whole topology (`aws-cdk-lib` is an optional peer dependency):

```typescript
import { GurenLambdaApp } from '@guren/plugin-lambda/cdk'

new GurenLambdaApp(stack, 'App', {
  functionDir: '../.lambda/function',
  assets: { dir: '../.lambda/assets' },   // S3 + CloudFront
  queue: {},                              // SQS + worker + DLQ
  console: true,                          // aws lambda invoke, dispatching src/console.ts's kernel
  dataApi: {                              // DATABASE_* env + rds-data/secret grants
    database: 'appdb',
    resourceArn: process.env.DATABASE_RESOURCE_ARN!,
    secretArn: process.env.DATABASE_SECRET_ARN!,
  },
  // APP_URL is the app's public base URL. Emailed links (password reset,
  // email verification) are built from it rather than the request host.
  environment: { APP_KEY: process.env.APP_KEY!, APP_URL: process.env.APP_URL! },
})
```

HTTP API, queue worker with partial batch failures, EventBridge scheduling, and asset routing (`/assets/*`, `/public/*`) come wired with the handler names `lambda:build` emits. Every sub-resource is exposed as a property for further customization.

## Things Lambda changes

- **Bundle time is production.** `bun build` inlines `process.env.NODE_ENV` when bundling; the build pins it to `"production"` so runtime configuration cannot accidentally ship a development bundle.
- **The filesystem is read-only** except `/tmp`. Sessions and cache need a store that survives invocations — `DatabaseSessionStore`, or Redis via `@guren/core/redis`.
- **Passwords hash with Node's scrypt.** The default hasher detects the runtime and uses `NodeHasher` off Bun; hashes are not interchangeable with Bun's `ScryptHasher`.
- **Static assets belong on S3 + CloudFront**, not in the function. Point real asset URLs at the function's environment (`GUREN_INERTIA_ENTRY`, `GUREN_INERTIA_STYLES`) to override the baked same-origin defaults.
- **The database wants the RDS Data API.** `createAwsDataApiDatabase` from `@guren/core` connects to Aurora Serverless v2 over HTTP — no pool, no RDS Proxy, no VPC. Classic RDS works too with `createPostgresDatabase` plus RDS Proxy (`clientOptions: { prepare: false, max: 1 }`).

See the [Serverless Deployment Guide](https://guren.dev/docs/guides/serverless) for the full setup, including SQS, EventBridge, and CDK.
