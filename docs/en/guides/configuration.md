# Configuration

A Guren app keeps its configuration in `config/`. Two kinds of file live there:

- `config/env.ts` declares every environment variable the app reads, with its type and whether it is required. The app validates them once, when it boots.
- `config/<service>.ts` files (`database`, `cache`, `mail`, `session`, ...) turn those validated values into service configuration. Each default-exports a *config definition*.

Both are plain data. Importing them opens no connection and registers nothing; `createApp()` does that.

```ts
// src/app.ts
import { createApp } from '@guren/core'
import cache from '../config/cache.js'
import database from '../config/database.js'
import env from '../config/env.js'
import http from '../config/http.js'
import { registerWebRoutes } from '../routes/web.js'

const app = createApp({
  env,
  config: [database, http, cache],
  routes: registerWebRoutes,
})

export default app
```

`create-guren-app` writes this shape, and `guren add cache`, `guren add mail`, `guren add queue`, `guren add storage`, `guren add session` and `guren add oauth` add their definition to the `config` array.

## Declaring the environment

`config/env.ts` default-exports a `defineEnv()` schema:

```ts
// config/env.ts
import { defineEnv, Env, type InferEnv } from '@guren/core'

const env = defineEnv({
  APP_KEY: Env.string().secret().requiredInProduction()
    .describe('Signs cookies and encrypts session payloads.'),
  APP_URL: Env.url().requiredInProduction(),
  PORT: Env.port().default(3333),
  DATABASE_URL: Env.string().optional(),
  CACHE_STORE: Env.string().default('memory'),
  LOG_LEVEL: Env.enum(['debug', 'info', 'warn', 'error']).default('info'),
})

export default env

declare module '@guren/core' {
  interface AppEnv extends InferEnv<typeof env> {}
}
```

The `declare module` block types the validated values everywhere the app reads them: in definitions, in `this.make('env')` from a controller, and in a database connection resolver.

### Types

| Builder | Accepts | Value |
|---|---|---|
| `Env.string()` | anything | `string` |
| `Env.url()` | what `new URL()` parses | `string` |
| `Env.number()` | a finite number | `number` |
| `Env.port()` | an integer from 1 to 65535 | `number` |
| `Env.boolean()` | `true`, `false`, `1`, `0` (any case) | `boolean` |
| `Env.enum([...])` | one of the listed strings | the union of them |
| `Env.custom(schema)` | whatever a synchronous Standard Schema (Zod, Valibot) accepts | the schema's output |

### Presence

A variable is required unless it says otherwise:

| Modifier | When the variable is unset |
|---|---|
| (none) | the boot fails |
| `.optional()` | the value is `undefined` |
| `.default(value)` | the value is `value` |
| `.requiredInProduction()` | the boot fails when `NODE_ENV` is `production`; `undefined` elsewhere |

**A blank value counts as unset.** `REDIS_URL=` in `.env` reads the same as no line at all, so it takes the default, or fails a required variable. Blank is what a `.env.example` usually ships and what a hosting dashboard leaves behind for a cleared variable. Chain `.allowEmpty()` when an empty string is a real value, such as a mail display name someone chose to leave out.

`.secret()` keeps the value out of error messages and makes `guren env:example` write the key blank. `.describe(text)` becomes the comment above the key in `.env.example`.

### When validation fails

The boot stops with every problem at once:

```text
[guren] Invalid environment (2 problems):
  APP_KEY  required, not set
  PORT     "80a" is not a port
```

### What you cannot declare

`NODE_ENV` and every `GUREN_*` variable stay raw `process.env` reads, and `defineEnv()` throws if you list one. Deploy builds replace the exact expression `process.env.NODE_ENV` at bundle time, which a validated value would bypass, and `GUREN_*` switches (`GUREN_MCP`, `GUREN_DOCS`) are framework gates that must not depend on your schema.

## Config definitions

A definition receives the validated env and returns the service's configuration:

```ts
// config/cache.ts
import { defineCacheConfig } from '@guren/core'
import { createRedisClient } from '@guren/core/redis'

export default defineCacheConfig((env) => ({
  default: env.CACHE_STORE,
  stores: {
    memory: { driver: 'memory' },
    // A function, so the client is built only when CACHE_STORE selects this store.
    redis: { driver: 'redis', client: () => createRedisClient({ url: env.REDIS_URL }) },
  },
}))
```

| Helper | Binds | Configuration |
|---|---|---|
| `defineDatabaseConfig(database, { seedOnBoot })` | `database` | connects the ORM at boot, and seeds when `seedOnBoot` is true and migrations exist |
| `defineHttpConfig` | (the HTTP kernel) | `hostAuthorization` |
| `defineSessionConfig` | `session` | a `SessionConfig` |
| `defineCacheConfig` | `cache` | a `CacheConfig` |
| `defineMailConfig` | `mail` | a `MailConfig` |
| `defineQueueConfig` | `queue` | a `QueueConfig` |
| `defineStorageConfig` | `storage` | a `StorageConfig` |
| `defineOAuthConfig` | `oauth` | `providers` and an optional `stateStore` |

`createApp()` registers a `ConfigServiceProvider` ahead of your providers. In its `register()` it validates the env and binds every definition's manager; in its `boot()` it runs the definitions' boot work (the database connection) before any other provider boots. So a provider can resolve `cache` or `mail` in its own `register()`, and the order of the `config` array does not matter.

**A key is configured once.** If a definition and a provider both bind `cache`, the boot fails and names both, rather than one silently winning. When you move a service to a definition, delete its provider.

Name checks belong in the definition. A manager accepts any store name and throws on first use, which may be a queued job hours later, so the scaffolds check at boot:

```ts
// config/queue.ts
import { defineQueueConfig, MemoryDriver, SyncDriver } from '@guren/core'

const drivers = {
  sync: () => new SyncDriver(),
  memory: () => new MemoryDriver(),
}

export default defineQueueConfig((env) => {
  if (!Object.hasOwn(drivers, env.QUEUE_CONNECTION)) {
    throw new Error(
      `QUEUE_CONNECTION="${env.QUEUE_CONNECTION}" is not a declared driver. Declare it in config/queue.ts or use one of: ${Object.keys(drivers).join(', ')}.`,
    )
  }

  return { default: env.QUEUE_CONNECTION, drivers }
})
```

Conditional configuration is ordinary code in the callback:

```ts
// config/oauth.ts
import { defineOAuthConfig, type OAuthProviderConfig, createGitHubOAuthProviderConfig } from '@guren/core'

export default defineOAuthConfig((env) => {
  const providers: Record<string, OAuthProviderConfig> = {}

  if (env.OAUTH_GITHUB_CLIENT_ID && env.OAUTH_GITHUB_CLIENT_SECRET && env.OAUTH_GITHUB_REDIRECT_URI) {
    providers.github = createGitHubOAuthProviderConfig({
      clientId: env.OAUTH_GITHUB_CLIENT_ID,
      clientSecret: env.OAUTH_GITHUB_CLIENT_SECRET,
      redirectUri: env.OAUTH_GITHUB_REDIRECT_URI,
    })
  }

  return { providers }
})
```

## The database connection

`config/database.ts` keeps its named exports, because `guren db:migrate` and `guren db:seed` import them outside a running app. Its connection resolver receives the validated env when the app boots, and parses the schema itself when the CLI calls it:

```ts
// config/database.ts
import { createPostgresDatabase, defineDatabaseConfig } from '@guren/core'
import env from './env.js'

const database = createPostgresDatabase({
  migrationsFolder: new URL('../db/migrations', import.meta.url),
  seedersFolder: new URL('../db/seeders', import.meta.url),
  connectionString: (context) => (context?.env ?? env.parse(undefined, { mode: 'report' }).values).DATABASE_URL
    ?? 'postgres://guren:guren@localhost:54322/guren',
})

export const { getDatabase, migrateDatabase, closeDatabase, configureOrm, seedDatabase } = database

export default defineDatabaseConfig(database, { seedOnBoot: process.env.NODE_ENV !== 'production' })
```

`mode: 'report'` returns the values it could validate instead of throwing, so `guren db:migrate` in production does not demand `APP_KEY` just to reach the database.

## Keeping `.env.example` in step

`config/env.ts` is the list; `.env.example` should name the same keys.

```bash
bunx guren env:example
```

appends every declared key that `.env.example` lacks, with its default (blank for a secret) and its description as a comment. Lines already there are left as you wrote them.

```bash
bunx guren check --env
```

fails when the two disagree in either direction, which makes it a CI gate. Plain `guren check` runs the same comparison, and also reports a `config/<name>.ts` that `createApp({ config })` never lists.

## Reading the environment in code

Read validated values from the container rather than `process.env`:

```ts
import { Controller } from '@guren/core'

export default class AdminController extends Controller {
  async index() {
    const { ADMIN_EMAIL } = this.make('env')
    // ...
  }
}
```

In a scaffolded app, the `guren/no-unvalidated-env-read` lint rule reports a `process.env.X` read under `app/`, `config/`, `routes/`, `src/` and `modules/` when `X` is not `NODE_ENV` or a `GUREN_*` variable. `bin/` and `drizzle.config.ts` run before any app exists and are left alone. Where a raw read is deliberate, disable the line and say why:

```ts
// oxlint-disable-next-line guren/no-unvalidated-env-read -- CI switch, not app config
const secureCookies = process.env.NODE_ENV === 'production' && !process.env.CI
```

## Cloudflare Workers

On Workers, wrangler `vars` and secrets arrive on the entrypoint's `env` argument and are not guaranteed to reach `process.env`. `@guren/plugin-cloudflare` binds that argument before the app boots, and the schema reads a key from it first, then from `process.env`. The same `config/env.ts` works locally and on Workers with no changes.

## Tests

`TestApp.fromApp(app)` boots your real `src/app.ts`, definitions included, so a feature test runs against the configuration production uses.

To try one variable without touching `process.env`, pass the schema and the overrides to `TestApp.create()`. `envSource` is read ahead of `process.env`, and `''` makes a variable unset:

```ts
import { TestApp } from '@guren/testing'
import env from '../config/env.js'

const app = await TestApp.create({
  env,
  envSource: { CACHE_STORE: 'memory', APP_URL: '' },
  providers: [ReportProvider],
})
```

An invalid override makes `create()` reject with an `EnvValidationError`.

## Apps with service providers

An app created before config definitions configures services in providers (`CacheProvider`, `MailProvider`, a `SessionProvider` reading `config/session.ts`). Those keep working, and nothing requires moving them. When you do:

1. Add `config/env.ts` and declare the variables the provider reads.
2. Write `config/<service>.ts` with the matching `define*Config` helper, reading `env` instead of `process.env`.
3. Add it to `createApp({ config })` and delete the provider from `providers`, in the same change.
4. Run `bunx guren env:example` and `bunx guren check`.

Once `config/env.ts` exists and no provider binds the key, `guren add <service>` writes the definition form for the next service you add.
