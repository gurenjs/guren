# RFC: Pluggable Session Drivers

**Author:** 7nohe
**Date:** 2026-09-06
**Status:** Accepted (2026-09-06 — the standard two-week discussion window
was shortened by the deciding maintainer for this solo-driven change; Part 0
was implemented against the draft the same day, PR #704)

## Problem

A scaffolded Guren app that adds authentication keeps its sessions in process
memory, and nothing in the scaffold ever changes that. On one long-lived Bun
server that is correct. On Cloudflare Workers each request may run in a
different isolate with no shared memory, so the session written during the
login POST is absent on the very next request: the user appears logged out,
and it reproduces only after deploying. Lambda has the same failure. guren.dev
works only because `web/src/app.ts` wires `new DatabaseSessionStore(sessions)`
by hand.

What exists today (verified at `5afbe9a9`):

- `SessionOptions` (`packages/server/src/http/middleware/session.ts`) has one
  selection field, `store?: SessionStore`. There is no driver name, no
  registry, no config file. Three implementations exist: `MemorySessionStore`
  (default), `DatabaseSessionStore` (`@guren/core`, `new DatabaseSessionStore(table)`),
  `RedisSessionStore` (`@guren/core/redis`, takes an ioredis client).
- **The scaffold already promises a driver switch it does not have.**
  `packages/create-app/templates/default/.env.example` ships
  `SESSION_DRIVER=memory` with `# SESSION_DRIVER=redis` beneath it, and
  `docs/en/guides/getting-started.md` documents `SESSION_DRIVER` as a setting
  to "switch to `redis` for multi-process deployments". No file in
  `packages/`, `docs/`, `examples/` or `web/` reads `SESSION_DRIVER`
  (`CACHE_STORE` is in the same state; `QUEUE_CONNECTION` and `MAIL_MAILER`
  are read by their scaffolded providers). A user who follows the env file
  changes nothing.
- RFC 0003 Part 3 promised a "per-dialect `sessions` scaffold" next to
  `DatabaseSessionStore`. The store shipped; the scaffold did not.
  `DatabaseSessionStore` appears in `packages/cli` and `packages/create-app`
  only in `tests/deploy-runtime.test.ts`. `guren add` has blueprints for
  admin, attachments, auth, oauth, broadcasting, cache, events, lint, mail,
  notifications, queue, resource, plugin, schedule and storage: none for
  sessions, and `guren add auth` wires `auth: {}` into `createApp()` (which
  turns sessions *on*) without ever choosing a store.
- The one thing that detects the hazard, `detectDeployRuntimeStores` in
  `packages/cli/src/doctor.ts` over `deploy-runtime.ts`, is reached only from
  `guren doctor`. `guren check` does not run it, so neither `guren gate` nor
  the scaffolded CI does, and none of `cloudflare:build`, `lambda:build` or
  the Vercel build script does. `cloudflare:build && wrangler deploy` ships a
  memory-session app without printing the warning.
- The OAuth state store has the identical defect one layer over:
  `OAuthServiceProvider` binds `createOAuthManager()` with no `stateStore`,
  which defaults to `MemoryOAuthStateStore`, and the `oauth` scaffold never
  passes one.

### Two established shapes in the codebase, and a third

The repo already answers "how is a backend chosen" three different ways:

| Subsystem | Config shape | Registry | Plugin-extensible? |
|---|---|---|---|
| cache | `{ default, stores: Record<name, { driver: 'memory' \| 'redis' \| 'file', ...opts }> }` | `CacheManager.driverFactories` + `registerDriver()` | No: `StoreConfig` is a closed union and the constructor resolves every entry eagerly, so a driver registered later still throws `Unknown cache driver` |
| storage | `{ default, disks: Record<name, { driver: 'local' \| 's3' \| 'memory', ...opts }> }` | same, `registerDriver()` / `registerDisk()` | Same closed union; RFC 0009 had to ship `R2Driver` through `registerDisk(name, () => driver)` and lists an "augmentable driver registry" as follow-up (b), still unshipped |
| queue | `{ default, drivers: Record<name, () => QueueDriver> }` | `QueueManager` resolves lazily on `driver()` | Yes, trivially: the config *is* factories. `setQueueDriver(instance)` is the global slot the manager publishes into, not a competing config shape |
| session | `store?: SessionStore` | none | Yes, but only by constructing the instance yourself |

So the premise "queue is instance-passing like sessions" is not quite right:
queue is the *lazy, factory-shaped* one, and it is the only one a plugin can
extend without a server release. What it lacks is the typed `driver:` sugar
that lets a config file be read by a static check. Sessions should get the
cache-style typed union **and** queue-style lazy resolution, with the union
open to augmentation, and the RFC says why each half matters below.

### The constraint a driver name alone does not remove

Naming a driver is the easy part. `database` needs a `sessions` table the app
declares in `db/schema.ts` and a migration; `redis` needs a connection; a
Workers-native store needs a binding in `wrangler.jsonc`; DynamoDB needs a
table with a TTL attribute and credentials. Laravel's answer is a generator
(`make:session-table`, formerly `session:table`) plus a default migration
that already contains the table; Rails' answer is to need no resource at all
(encrypted cookie store). This RFC has to cover how the resource gets
declared and created, not only how the driver gets named.

## Prior art (read 2026-09-06, not from memory)

**Laravel 12.x / 13.x** (`config/session.php`, `SessionManager`). Drivers:
`file`, `cookie`, `database`, `memcached`, `redis`, `dynamodb`, `array`;
`SESSION_DRIVER` defaults to **`database`** (since 11; unchanged in 13). Keys:
`driver`, `lifetime` (120 min), `expire_on_close`, `encrypt`, `files`,
`connection` (`SESSION_CONNECTION`, for database/redis), `table`
(`SESSION_TABLE`, default `sessions`), `store` (`SESSION_STORE`, the cache
store a cache-backed driver uses), `lottery` (`[2, 100]`: drivers that cannot
self-expire sweep on a random 2% of requests), cookie attributes. The
`memcached`, `dynamodb` (and `apc`) drivers are `createCacheBased(driver)`:
they reuse the cache manager's store of that name rather than owning a
client. `redis` is cache-based too but rewires the connection from
`session.connection`. The `database` driver reads `session.table`,
`session.lifetime`, `session.connection`. The table (`make:session-table`
stub) is `id string PK, user_id nullable indexed, ip_address(45) nullable,
user_agent text nullable, payload longText, last_activity integer indexed`,
and is included in the default `create_users_table` migration so a fresh app
never runs the generator. DynamoDB: a table (`DYNAMODB_CACHE_TABLE`, default
`cache`) with a string partition key named `key` and **TTL enabled on an
attribute named `expires_at`**, `aws/aws-sdk-php` installed, `AWS_*` env.
Custom drivers: `Session::extend('name', fn)` in a provider's `boot()`;
`SESSION_DRIVER=name` then selects it. Session blocking (per-session lock)
exists and excludes the `cookie` driver.

**Rails 8** (configuring guide, security guide, `activerecord-session_store`).
`config.session_store :cookie_store, key: "_app_session"` is a method call so
options ride along; values `:cookie_store` (default), `:cache_store`,
`:mem_cache_store`, a custom class, `:disabled`. The cookie store keeps the
whole session hash in the cookie, encrypted and signed with
`secret_key_base` (authenticated encryption on by default since 5.2, JSON
serializer since 7.0). Constraints the security guide states outright:
cookies are capped at **4 kB**; "session cookies do not invalidate themselves
and can be maliciously reused", so anything that must be revocable belongs in
the database with only the user id in the session; `reset_session` after
login against fixation. The database store was extracted to the
`activerecord-session_store` gem: `rails generate active_record:session_migration`,
table `id, session_id(255) indexed, data text/json, created_at, updated_at`,
cleanup by a `db:sessions:trim` rake task on a schedule (30-day threshold
via `SESSION_DAYS_TRIM_THRESHOLD`).

**Cloudflare KV** (docs updated 2026-04-21): "eventually-consistent";
changes "may take up to 60 seconds or more to be visible in other global
network locations"; a read at the writing location is "usually immediately"
consistent but "this is not guaranteed and therefore it is not advised to
rely on this behaviour". Login → redirect → read is exactly the flow that
guarantee is missing from. RFC 0003 §3 rejected a KV session store on these
grounds; nothing has changed.

What Guren takes from this: Laravel's `database` default and its generator
(the resource is created by the same command that selects the driver), its
cache-backed trick for DynamoDB (one client, not two), Rails' cookie store as
the zero-resource option with its caveats stated the way Rails states them,
and neither framework's `lottery` (Guren already has `deleteExpired()` on the
database store and a scheduler; a `sessions:prune` command is the honest
form of it).

## Proposed Solution

Four pieces, each answering one of the points in the problem statement:

1. A typed, **augmentable** driver registry and a lazily-resolving
   `SessionManager` in `@guren/server`; the `database` driver registered by
   `@guren/core`, where the ORM-backed store already lives (§1).
2. `guren add session`: the resource-creating blueprint (`sessions` table per
   dialect, migration, `config/session.ts`, `SessionProvider`, prune
   command), called by `guren add auth` so a fresh app never sees the memory
   default in production (§2).
3. A `cookie` driver: encrypted, stateless, needs no binding, with Rails'
   caveats in the docs (§3). Platform drivers live in the deploy plugins:
   `dynamodb` in `@guren/plugin-lambda`; Cloudflare uses the `database`
   driver over D1 already, a Durable Object driver is a deferred follow-up,
   and KV is not offered (§4).
4. The static check learns the config shape and runs where builds run (§5,
   split out as its own PR).

### 1. `SessionManager` and the driver registry (`@guren/server`)

```ts
// packages/server/src/http/middleware/session-drivers.ts

/**
 * Open registry: a plugin adds a driver by augmenting this interface, which is
 * what makes `{ driver: 'dynamodb' }` type-check in an app's config/session.ts.
 * Hono's ContextVariableMap pattern; RFC 0009 follow-up (b).
 */
export interface SessionDrivers {
  memory: MemorySessionDriverOptions
  redis: RedisSessionDriverOptions
  cookie: CookieSessionDriverOptions
}

export type SessionStoreConfig = {
  [K in keyof SessionDrivers]: { driver: K } & SessionDrivers[K]
}[keyof SessionDrivers]

export interface SessionConfig extends SessionOptions /* cookie + ttl fields */ {
  /** @default 'memory' */
  default?: string
  stores?: Record<string, SessionStoreConfig>
}

export interface MemorySessionDriverOptions {}
export interface RedisSessionDriverOptions {
  /** ioredis client or a factory for one; a factory is called on first use. */
  client: unknown | (() => unknown)
  /** @default 'session:' */
  prefix?: string
}
export interface CookieSessionDriverOptions { /* §3 */ }

export type SessionDriverFactory<O = unknown> = (options: O, context: SessionDriverContext) => SessionStore
export interface SessionDriverContext {
  /** Cookie and TTL settings the middleware will use; a driver may need ttl. */
  readonly options: Required<Pick<SessionOptions, 'ttlSeconds' | 'cookieName'>>
}
```

```ts
// packages/server/src/http/middleware/SessionManager.ts
export class SessionManager {
  constructor(config: SessionConfig = {})
  /** Default store when `name` is omitted. Resolved on first call, memoized. */
  store(name?: string): SessionStore
  registerDriver<K extends keyof SessionDrivers>(name: K, factory: SessionDriverFactory<SessionDrivers[K]>): void
  registerDriver(name: string, factory: SessionDriverFactory): void
  /** The cookie/ttl half of the config, for the middleware. */
  readonly options: SessionOptions
  /** Calls `deleteExpired()` on every resolved store that has one. */
  pruneExpired(now?: Date): Promise<void>
}
```

Resolution is **lazy**: `store()` looks the driver up at call time, so a
driver registered from a plugin's `register()` serves a store the config
declared before the plugin loaded. That is the fix RFC 0009 wanted for
storage ((a) in its follow-ups) and it is not optional here: on Workers a D1
binding does not exist until the first request (`getWorkersEnv()` throws
before it), and the redis client factory should not open a socket at boot.
An unknown `default` name is still checked at construction, as the scaffolded
`StorageProvider` does, so a typo in `SESSION_DRIVER` fails the boot rather
than the first login.

**Container binding.** The manager is bound as `'session'`, by the app's
scaffolded `SessionProvider` (§2), the same way `'cache'`, `'storage'`,
`'mail'` and `'queue'` are bound today. `AuthServiceProvider.register()`
changes from

```ts
app.use('*', createSessionMiddleware({ cookieSecure, ...authOptions.sessionOptions }))
```

to resolving the store through the container at **first request**:

```ts
const resolveStore = (): SessionStore => {
  const manager = this.container.has('session') ? this.container.make<SessionManager>('session') : undefined
  const explicit = authOptions.sessionOptions?.store
  if (manager && explicit) {
    throw new Error('Sessions are configured twice: auth.sessionOptions.store and the "session" container binding. Keep one.')
  }
  return explicit ?? manager?.store() ?? new MemorySessionStore()
}
app.use('*', createSessionMiddleware({ cookieSecure, ...manager?.options, ...authOptions.sessionOptions, store: resolveStore }))
```

`CreateSessionMiddlewareOptions.store` therefore accepts `SessionStore |
(() => SessionStore)`; the middleware calls the thunk once and memoizes. This
is the only change to the middleware for §1. Cookie/TTL precedence: the
manager's `options` are the base, `auth.sessionOptions` overrides field by
field, because that is where existing apps already put `cookieSecure`.

**Runtime warning.** When the store the middleware ends up with is a
`MemorySessionStore` and the runtime is detectably serverless
(`isWorkersRuntime()`, or `AWS_LAMBDA_FUNCTION_NAME` / `VERCEL` in env), the
middleware warns once per process: `[guren] Sessions use MemorySessionStore
on <runtime>, which shares no memory between requests; run guren add session`.
The static check (§5) can be skipped; this cannot, and it fires in the deploy
log of exactly the app the problem statement describes.

**Built-in drivers in server:** `memory` (unchanged class), `redis` (wraps
`RedisSessionStore`; the client is passed in or produced by a factory, as
the cache `RedisStore` already takes `client: unknown`, so `@guren/server`
gains no ioredis import), `cookie` (§3).

**The `database` driver is registered by `@guren/core`,** not server:
`DatabaseSessionStore` wraps the table in an ORM `Model`, and server must
not depend on the ORM (RFC 0003, Alternatives). Core is the established home
for this glue, so core exports the factory the scaffold uses:

```ts
// packages/core/src/session-manager.ts
declare module '@guren/server' {
  interface SessionDrivers {
    database: DatabaseSessionStoreOptions & {
      /** Drizzle table with `id`, `data`, `expiresAt` columns (`sessions` from db/schema.ts). */
      table: unknown
    }
  }
}

/** Server's SessionManager with the ORM-backed `database` driver registered. */
export function createSessionManager(config: SessionConfig = {}): SessionManager {
  const manager = new SessionManager(config)
  manager.registerDriver('database', ({ table, ...options }) => new DatabaseSessionStore(table, options))
  return manager
}
```

Core-first apps import `createSessionManager` from `@guren/core` and get all
four drivers. An app that imports `SessionManager` from `@guren/server`
directly gets three and a type error on `driver: 'database'` only if it never
imports core: acceptable, and `audit:core-first` already steers away from it.

**Why `table` is required in the config and never typed by a developer.**
Point 2 of the brief asks whether a driver can resolve without the app
naming a table. It can, but not the way it first looks. Core cannot construct
the `sessions` table itself: a table drizzle-kit does not see in
`db/schema.ts` gets no migration, and shipping one `pgTable`/`sqliteTable`/
`mysqlTable` definition per dialect from core would pull every dialect's
drizzle core into every app. So the convention lives one level up: `guren
add session` writes the table into `db/schema.ts` **and** writes
`config/session.ts` importing it, and `guren check` verifies the two agree
(§5). The developer names nothing; the driver still receives a real table
object. The zero-resource answer to point 2 is the `cookie` driver (§3).

**Queue, cache, storage are deliberately untouched.** Queue already has
lazy factory resolution and needs nothing from this RFC. Cache and storage
would benefit from the augmentable interface (their closed unions are what
forced RFC 0009 onto `registerDisk`), and `SessionDrivers` is written so the
same shape can be applied to `CacheDrivers`/`StorageDrivers` later, but that
is RFC 0009 follow-up (b), a separate additive change with its own tests,
not a rider on sessions.

### 2. `guren add session`, and what `guren add auth` does differently

A new blueprint, modelled on `guren add attachments` (`packages/cli/src/add-attachments.ts`),
which is the existing precedent for "schema table + config + provider + prune
command":

```
bunx guren add session [--driver database|cookie|redis] [--force]
```

Writes, per `detectSchemaDialect(db/schema.ts)`:

1. **`db/schema.ts`**: appends the `sessions` block for the dialect, with
   imports patched through `ensurePgImports`/`ensureSqliteImports`/
   `ensureMysqlImports`. The columns are what `DatabaseSessionStore`
   already documents (`id`, `data`, `expiresAt`), one shape per dialect:

   ```ts
   // pg
   export const sessions = pgTable('sessions', {
     id: text('id').primaryKey(),
     data: jsonb('data').$type<Record<string, unknown>>().notNull(),
     expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
   }, (t) => [index('sessions_expires_at_idx').on(t.expiresAt)])
   // sqlite / D1
   export const sessions = sqliteTable('sessions', {
     id: text('id').primaryKey(),
     data: text('data', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
     expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
   }, (t) => [index('sessions_expires_at_idx').on(t.expiresAt)])
   // mysql
   export const sessions = mysqlTable('sessions', {
     id: varchar('id', { length: 64 }).primaryKey(),
     data: json('data').$type<Record<string, unknown>>().notNull(),
     expiresAt: timestamp('expires_at').notNull(),
   }, (t) => [index('sessions_expires_at_idx').on(t.expiresAt)])
   ```

   The `expires_at` index is new relative to guren.dev's table: `touch()`
   and `deleteExpired()` both filter on it. Laravel's `user_id`,
   `ip_address`, `user_agent` columns are not adopted: the `SessionStore`
   contract carries neither, and "sessions for user X" is a feature request
   (`logoutOtherDevices`) this RFC does not make.
2. **`config/session.ts`**, shaped like the scaffolded `StorageProvider`
   (declare every store, pick by env, refuse unknown names at boot):

   ```ts
   import type { SessionConfig } from '@guren/core'
   import { sessions } from '../db/schema.js'

   // Declared once, chosen per environment: SESSION_DRIVER in .env (or your
   // platform's vars) picks a store below. Stores are built on first request,
   // so a store you never select never opens a connection.
   export const sessionConfig: SessionConfig = {
     default: process.env.SESSION_DRIVER ?? 'database',
     ttlSeconds: 60 * 60 * 2,
     stores: {
       // Survives restarts, isolates and cold starts; needs the sessions
       // table this command added to db/schema.ts (run the migration).
       database: { driver: 'database', table: sessions },
       // Encrypted, stateless, needs no table or binding. Whatever you put
       // in the session travels in the cookie: 4 KB cap, and a logout cannot
       // revoke a copied cookie before it expires. Keep only ids in it.
       cookie: { driver: 'cookie' },
       // Per-process only. Fine on one Bun server, wrong on Workers/Lambda.
       memory: { driver: 'memory' },
     },
   }
   ```

   `--driver redis` adds a `redis` entry with
   `client: () => createRedisClient({ url: process.env.REDIS_URL })` from
   `@guren/core/redis` and sets the default to it.
3. **`app/Providers/SessionProvider.ts`**:

   ```ts
   import { ServiceProvider, createSessionManager } from '@guren/core'
   import { sessionConfig } from '../../config/session.js'

   export default class SessionProvider extends ServiceProvider {
     register(): void {
       this.container.instance('session', createSessionManager(sessionConfig))
     }
   }
   ```

   wired into `createApp({ providers })` through `wireProviders`.
4. **`app/Console/Commands/SessionsPrune.ts`** (`sessions:prune`, registered
   in `src/console.ts` when it exists, exactly as `attachments:prune` is),
   calling `manager.pruneExpired()`. RFC 0003 amended `sessions:prune` into
   `deleteExpired()` "documented as a scheduled job"; guren.dev never
   scheduled it (verified: no `deleteExpired` call under `web/`). A command
   the scaffold ships and the docs tell you to schedule is the version of
   that promise that gets kept.
5. **`.env.example`**: `SESSION_DRIVER=database` with the `cookie` and
   `redis` alternatives commented beneath, replacing the dead
   `SESSION_DRIVER=memory` line; `getting-started.md` line 93 becomes true.
6. **Migration**: `makeMigration({ name: 'create_sessions_table' })` when
   drizzle-kit is installed, the way `make:auth` generates
   `create_users_table`; otherwise the "run `bun run db:make`" note.

**`guren add auth` calls it.** `installAuth()` in `make-auth.ts` gains a step
after `addCreateAppOption(appPath, 'auth', '{}')`: run the session blueprint
unless `config/session.ts` exists or `--no-session` is passed. The users and
sessions tables then land in one `db:make` run, matching Laravel's default
migration. `make:auth` without `--install` prints the blueprint as a next
step. The API-only template goes through the same path; sessions there are
enabled by `auth: {}` exactly as in the default template, so the wiring is
not conditional on Inertia.

**Not a config-file change to `createApp`.** `session` does not become a
top-level `createApp()` option (Alternatives). The container binding is how
every other backend-selecting subsystem is wired, and it is what lets a
plugin call `container.make('session').registerDriver(...)` in its
`register()`.

### 3. The `cookie` driver

The one driver that needs no server-side resource: it works on Workers with
no binding, on Lambda with no table, on a Bun server with no database, and it
is what makes point 2 of the brief answerable without a table. Rails ships it
as the default; Guren ships it as an option with Rails' caveats attached.

The current `SessionStore` contract is keyed by id and never sees the cookie,
so a cookie store cannot implement it as-is. Rather than special-casing a
class in the middleware, the contract grows one optional capability:

```ts
export interface SessionStore {
  read(id: string): Promise<SessionData | undefined>
  write(id: string, data: SessionData, ttlSeconds: number): Promise<void>
  destroy(id: string): Promise<void>
  touch?(id: string, ttlSeconds: number): Promise<void>
  /**
   * Present on stores that keep the session *inside* the cookie. The
   * middleware then writes `encode()`'s value as the cookie instead of the
   * signed id, and feeds the cookie back through `decode()` on the next
   * request. `read`/`write`/`destroy` are still called with the id from
   * the decoded payload so the middleware's flow does not fork.
   */
  inline?: {
    encode(id: string, data: SessionData, ttlSeconds: number): string
    decode(cookieValue: string): { id: string; data: SessionData } | null
  }
}
```

`CookieSessionStore` implements `inline` with the existing `Encrypter`
(AES-256-GCM under the app key, previous keys accepted for rotation, which
`createCookieSigner` already does for the signed-id cookie) and
`read`/`write`/`destroy` as no-ops over a per-request slot. The payload
carries `id`, `data`, and `expiresAt`; `decode` refuses an expired or
undecryptable payload, which makes `ttlSeconds` real even though nothing
server-side can expire the cookie early. `regenerate()` stays meaningful for
CSRF binding (the token is bound to the id) and harmless otherwise.

Behaviour the docs state outright, in Rails' words where possible:

- Everything in the session travels in the cookie: **4 KB** cap, enforced by
  refusing to encode a payload over the limit with an error naming the size.
- A logout cannot revoke a cookie the client already copied; it is valid
  until `expiresAt`. Keep ids in the session, keep anything revocable in the
  database. `invalidate()` clears the cookie on this client only.
- Not for apps that need "log out everywhere" or session listing.
- The `X-Testing-Session` header still works: the middleware merges it after
  `decode()`, as it merges after `read()` today.

### 4. Where drivers live

| Driver | Package | Resource it needs | Who creates the resource |
|---|---|---|---|
| `memory` | `@guren/server` | none | n/a |
| `cookie` | `@guren/server` | `APP_KEY` (already required) | n/a |
| `redis` | `@guren/server` (client from `@guren/core/redis`) | a Redis, `REDIS_URL` | the platform; the blueprint writes the entry |
| `database` | `@guren/core` | `sessions` table | `guren add session` (schema + migration) |
| `dynamodb` | `@guren/plugin-lambda` | table, partition key `id`, TTL on `expires_at`, `AWS_*` | the plugin's CDK construct gains `sessionsTable: true`; docs give the CLI equivalent |
| `durable-object` | `@guren/plugin-cloudflare`, **deferred** | a DO class + `durable_objects` binding + migration in `wrangler.jsonc` | `cloudflare:build` already scaffolds DO bindings for agents (RFC 0017 §6); the same path would add this one |
| KV | not offered | | |

**Cloudflare: the `database` driver over D1 is the Workers driver.** It is
what guren.dev runs, it is strongly consistent, and it needs no new binding
beyond the `d1_databases` entry `cloudflare:build` already scaffolds. A
Durable Object store (strongly consistent, `SqlStorage`-backed, one object
per session id) is the follow-up RFC 0003 reserved "only if D1 session
latency proves problematic"; that trigger has not fired on guren.dev, so the
driver stays out of this RFC and its `SessionDrivers` augmentation is the
documented extension point when it does. **KV is not offered and the docs
say why** (Prior art, above): a session written at login is not guaranteed
readable on the redirect that follows.

**Lambda: `dynamodb` via augmentation in `@guren/plugin-lambda`.** New code:
a `DynamoDbSessionStore` on `@aws-sdk/client-dynamodb` (loaded lazily with
the same "missing optional dependency" pattern as `S3Driver`), items
`{ id: S, data: S(JSON), expires_at: N (epoch seconds) }`, conditional
`touch` (`attribute_exists(id) AND expires_at > :now`), TTL left to the
table's TTL attribute with `read` treating a past `expires_at` as missing
(DynamoDB TTL deletes lazily, within 48 hours). The CDK construct adds an
optional `sessionsTable` that creates the table with TTL enabled and grants
the function access; `gurenPlugin.env` gains `DYNAMODB_SESSIONS_TABLE`.
The `database` driver over Aurora Data API remains the documented default on
Lambda (serverless.md already recommends it); `dynamodb` is for apps that
want session churn off the primary database, which is where Laravel's
guidance lands too.

**Plugin manifest declares its drivers.** So the static check (§5) can judge
a driver it did not ship, `gurenPlugin` gains:

```json
"drivers": { "session": [{ "name": "dynamodb", "persistent": true }] }
```

Declarative data the CLI reads from `node_modules` the way it reads
`compatibility` today; never executed. A `driver:` string the check finds in
neither the built-in list nor any installed manifest is reported as
*unverified*, not as passing: an unavailable check is not a green one.

### 5. The static check learns the config shape, and runs where builds run

Separable, and smaller than everything above: **land it first as its own
PR**, before Part 1, because the warning is useful even for an app that
wires `DatabaseSessionStore` by hand today.

- `detectDeployRuntimeStores` (the "Deploy Runtime Stores" doctor check)
  joins `guren check` as a `warn` (informational, never sets the exit code,
  like the doc-link checks). `guren gate` and the scaffolded CI run `check`,
  so the hazard is seen on every change of an app that declares a deploy
  plugin. `doctor` keeps its copy.
- The three deploy builds call it and print the warning: `cloudflare:build`,
  `lambda:build`, and the Vercel build script all go through
  `@guren/core/internal/deploy-build`, so one hook in that module covers all
  three. Warn, do not fail: an app may back sessions in a way the scan cannot
  see (a custom `SessionStore`), and RFC 0003's `unparsedFiles` caveat
  applies.
- The signal extractor in `deploy-runtime.ts` today counts only
  *constructions* (`new DatabaseSessionStore(...)`). Once `config/session.ts`
  selects `driver: 'database'`, no construction exists, and the current check
  would report "sessions enabled with no DatabaseSessionStore" against a
  correctly configured app. So, with Part 1: an `ObjectProperty` `driver:
  '<name>'` in a Guren-importing file resolves through the built-in list
  (`memory` → `memoryStore`, `database`/`redis`/`cookie` → `backedSession`)
  plus installed manifests' `drivers.session`; the entry named by `default:`
  is the one that counts, and a `default` read from `process.env` with no
  literal fallback is reported as unverified. `config/` is already in
  `DEPLOY_SCAN_DIRS`.
- A `sessions-config` rule in `guren check`, next to the attachments rule: a
  `database` entry whose `table` is not an export of `db/schema.ts`, and a
  `config/session.ts` with no `SessionProvider` reaching `createApp()`
  (`routes-check`'s registrar logic, applied to providers). Both are the
  wiring mistakes that otherwise fail at the first login.

### Implementation plan

Referencing `RFC 0020` in each PR:

0. **Check placement** (§5, first two bullets): `guren check` gains the
   deploy-runtime store check; `deploy-build` prints it from the three
   builds. No new API. Its own PR.
1. **`@guren/server`**: `SessionDrivers`, `SessionStoreConfig`,
   `SessionConfig`, `SessionManager` (lazy, `registerDriver`,
   `pruneExpired`), `memory`/`redis` built-ins, `store` thunk in the
   middleware, `AuthServiceProvider` resolution with the double-configuration
   error, the serverless runtime warning. Additive; minor release.
2. **`@guren/core` + `@guren/cli`**: `createSessionManager` with the
   `database` augmentation; `guren add session`; `guren add auth` calling it;
   `.env.example`; `sessions-config` check; deploy-runtime extractor
   reading `driver:`; docs (authentication, cloudflare, serverless,
   getting-started). Core gets a changeset (the allowlist addition rule).
3. **`cookie` driver** (§3): `inline` capability, `CookieSessionStore`, the
   4 KB refusal, docs with the caveats. Can ship with 1 or after.
4. **`@guren/plugin-lambda`**: `dynamodb` driver, CDK `sessionsTable`,
   manifest `drivers.session`, CLI manifest reading.
5. **Dogfood**: guren.dev moves from `new DatabaseSessionStore(sessions)` to
   `config/session.ts` + `SessionProvider`, schedules `sessions:prune`; the
   blog example adopts the blueprint. The template smokes
   (`smoke:starter`, `smoke:starter:api`) assert the scaffolded app boots
   with `SESSION_DRIVER=database`, `cookie`, and `memory`.

Parts 1 and 2 are the release that makes `SESSION_DRIVER` real; templates
that use `createSessionManager` are red on `smoke:starter:npm` until it
ships (the documented templates-vs-published rule).

## Alternatives Considered

- **A `driver` string inside `auth.sessionOptions`, no manager.**
  Smallest diff, but the union has to stay closed (nothing to augment
  against without a registry object), `database` cannot be built by server,
  and there is nowhere for a plugin to register. It recreates the exact
  corner RFC 0009 had to work around.
- **`createApp({ session: sessionConfig })` as a top-level option.**
  Reads well, but `createApp` is in server and cannot resolve `database`;
  the container binding is how cache/storage/mail/queue are wired, and it is
  the seam plugins need.
- **Register the `database` driver by side effect when `@guren/core` is
  imported.** Every core-first app would get it for free, but a module-level
  side effect is what `sideEffects`-aware bundling removes and what the
  deploy plugins' stub sets do not expect; RFC 0003 and 0009 avoided it.
- **Have core construct a convention-named `sessions` table.** Discussed in
  §1: no migration would exist for it, and one definition per dialect drags
  every drizzle core into every app. The blueprint is the convention.
- **Lean on something drizzle already ships.** It ships nothing here:
  drizzle-orm's `session.ts` modules (`PgSession`, `SQLiteSession`, verified
  on 1.0.0-rc.4) are database connection sessions for query execution and
  transactions, and drizzle-kit has no session concept at all. The
  `sessions` tables people associate with drizzle are schema conventions of
  auth libraries (Auth.js adapter, Better Auth, Lucia), none of which Guren
  depends on.
- **Make `cookie` the scaffold default (Rails).** Zero resources, but a
  Guren app always has a database, `guren add auth` already generates a
  migration in the same run, and the cookie store's non-revocability is a
  worse default for an auth scaffold than one extra table. Laravel moved
  its default to `database` for the same reasons.
- **A KV driver with a "not for login" caveat.** Rejected again: the only
  thing sessions do is the flow KV does not guarantee, and a driver that is
  in the list is a driver someone selects.
- **Fold cache and storage into the same PR series.** Same interface
  pattern, different tests and different blast radius (both have closed
  unions user code already types against). Deferred to RFC 0009 (b).
- **Deprecate `store?: SessionStore`.** It is stable API (`@guren/core`
  re-export), in use by guren.dev and every doc snippet, and it is the
  escape hatch for a custom store. It stays; the boot-time error on
  double configuration is the only new rule around it.

## Migration Path

Additive. No existing call changes behaviour:

- `store?: SessionStore` keeps working. Setting it **and** binding a
  `'session'` manager is a boot error rather than a silent precedence.
- Apps with no `config/session.ts` and no `store` keep `MemorySessionStore`,
  plus the runtime warning on a serverless runtime (§1).
- guren.dev and any app using `new DatabaseSessionStore(sessions)` can move
  to the blueprint or not; `guren add session` refuses to overwrite an
  existing `config/session.ts` without `--force`, and the schema patch
  detects an existing `sessions` export and leaves it alone (the
  `usersTablePattern` precedent in `make-auth`).
- `SessionStore` gains only optional members (`inline`); a custom store from
  before this RFC type-checks unchanged.
- No deprecation is introduced, so `deprecations.ts` and `codemods.ts` are
  untouched. If a later RFC narrows `store`, it follows
  `contributing/deprecation-policy.md` (two minor versions, registered
  detector).

## Open Questions

1. **Tests and the `database` default.** A scaffolded app's tests run
   against the test SQLite file `config/database.ts` selects under
   `NODE_ENV=test`, so `database` sessions work there once migrations run.
   Should `config/session.ts` still force `memory` under `NODE_ENV=test` for
   speed, or is the fidelity of testing the real store worth a migration in
   `beforeAll`? Leaning: keep `database`; `TestApp` already injects state
   through `X-Testing-Session`, so most tests never write a row.
2. **Field name.** `stores` mirrors `CacheConfig` exactly; `drivers` mirrors
   `QueueConfig`. Sessions have one active store, which argues for the
   cache name; naming it once here settles it for the eventual
   `CacheDrivers`/`StorageDrivers` follow-up too.
3. **Session blocking.** Laravel's per-session lock has no Guren
   counterpart, and concurrent Inertia requests that both write the session
   can lose a write today, store-independent. Out of scope, noted because the
   `SessionManager` is where a `lock` capability would attach.
4. **Durable Object driver trigger.** RFC 0003 tied it to D1 latency. Is a
   user request enough, or does it wait for a measurement?
5. **OAuth state store.** Same defect, same fix shape (`DatabaseOAuthStateStore`
   exists, the scaffold never wires it). Should `guren add session` also
   write the `oauth_states` table and wire `stateStore` when `guren add
   oauth` has run, or does OAuth state get its own `stores` entry on this
   manager? The latter keeps one config file; the former keeps this RFC to
   sessions.
