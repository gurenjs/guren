# RFC: Declarative Config and a Validated Environment

**Author:** 7nohe
**Date:** 2026-09-15
**Status:** Accepted (2026-09-15 — the standard two-week discussion window
was shortened by the deciding maintainer for this solo-driven change)

## Problem

A scaffolded Guren app has a `config/` directory, and nothing about a file
being in it tells a reader what the file does or whether it runs. Verified at
`dcb81a7a`, `examples/blog/config/` holds five files with four different
meanings:

| File | What it is | How it takes effect |
|---|---|---|
| `config/app.ts` | `bootModels()` (`:29-42`): connects the ORM and seeds, guarded by a module-level `let bootstrapped`. No setting in it. | Imported by `app/Providers/DatabaseProvider.ts:2`, called from its `boot()` |
| `config/inertia.ts` | A `setInertiaSharedProps(...)` call at module scope (`:8`) | Import side effect only: `src/app.ts:30` is `import '../config/inertia.js'`, binding no name |
| `config/session.ts` | A `SessionConfig` object (`:15-29`) | Inert unless `app/Providers/SessionProvider.ts:2` imports it and that provider is listed in `createApp()`. Deleting the provider leaves the file in place and sessions in process memory, silently |
| `config/attachments.ts` | A module-scope `configureAttachments()` call plus `Model.morphMap = { Post }` (`:11-30`) | Import side effect, through `AttachmentsProvider.ts:4` |
| `config/database.ts` | Helpers the CLI and app code import (`db-migrate.ts:7-10`, `:129`; `web/app/Services/DocSearchService.ts:10`) | Named exports, no side effect |

The scaffold templates add a sixth meaning: `packages/cli/templates/scaffold/auth/config/mail.ts`
is a `MailConfig` object read by the scaffolded `MailProvider`, while
`guren add cache` and `guren add queue` put the same kind of object *inside*
the provider (`templates/scaffold/cache/app/Providers/CacheProvider.ts`,
`templates/scaffold/queue/app/Providers/QueueProvider.ts:6-14`).

### The environment is read everywhere and checked nowhere

Every value that varies per deployment is a raw `process.env` read at the point
of use. Across `packages/cli/templates/scaffold` and
`packages/create-app/templates`, 40 reads outside `NODE_ENV`, spread over 19
files, name 27 distinct variables. There is no schema, no type, and no moment
at which a missing or malformed value is reported: a typo in `SESSION_DRIVER`
throws `Session store not found` on boot (`session-manager.ts:120`), a missing
`OAUTH_GITHUB_CLIENT_SECRET` silently skips the provider
(`examples/blog/app/Providers/OAuthProvider.ts:10`), and a blank `SMTP_PORT=`
became port 0 until the scaffold learned to write `||`.

That last defect has a lint rule of its own, `guren/no-nullish-env-default`
(`packages/cli/src/oxlint/nullish-env-default.js:1-8`), because six scaffolded
configs shipped `process.env.FOO ?? 'default'`, and `??` keeps a blank `FOO=` as
`''`. The scaffold now carries the explanation inline (`config/session.ts:16`,
`auth/config/mail.ts:7`, `:20`), and one line disables the rule on purpose
(`auth/config/mail.ts:12`). A rule, three comments and a disable exist because
each config file is a place where an env string is parsed by hand.

The only env *declaration* mechanism is per plugin and install-time only:
`gurenPlugin.env` entries (`plugin-manifest.ts:16`, `:35-39`) that
`applyEnvEntries()` (`:266`) appends to `.env.example`. None of the seven
first-party plugins declares one. There is no `config()` accessor and no
equivalent of Adonis's `Env.create` schema.

Where reads happen also matters. Both templates' `src/app.ts` read `APP_URL` at
module scope inside `hostAuthorization()` (`templates/default/src/app.ts:16-36`,
`templates/api-only/src/app.ts:9-29`), and the comment there explains why a
missing value only warns: on Workers, wrangler `vars` are not guaranteed to reach
`process.env` before the module graph evaluates
(`packages/plugin-cloudflare/src/build.ts:1355-1358`). So a production host
check fails *open* on the one runtime where it cannot see the value yet.

### Provider order carries meaning that only prose records

`examples/blog/src/app.ts:66-85` lists 18 providers. Their order is load-bearing
in ways the array cannot show:

- `SessionProvider` must bind in `register()`, not `boot()`, because
  `AuthServiceProvider.boot()` builds the session middleware around that binding
  before any app provider boots. Two comments say so
  (`examples/blog/app/Providers/SessionProvider.ts:5-6`,
  `packages/server/src/providers/AuthServiceProvider.ts:15-19`).
- Every `Core*ServiceProvider` entry must precede the app provider of the same
  subsystem. `CacheServiceProvider.register()` binds `cache` unconditionally
  (`providers/CacheServiceProvider.ts:6-8`); listed after `CacheProvider`, it
  replaces the app's configured manager with an empty default. `MailServiceProvider`
  documents the dependency in prose (`MailServiceProvider.ts:4-10`: "The
  scaffolded `MailProvider` rebinds `mail`"). Of the framework's default
  providers, only `EncryptionServiceProvider` guards its binding
  (`EncryptionServiceProvider.ts:14`).
- `OAuthProvider.register()` calls `make('oauth')` (`OAuthProvider.ts:5`), which
  exists only because `CoreOAuthServiceProvider` registered first.
- `Application.warnOnUnconfiguredAuth()` (`Application.ts:800-810`) runs after
  every provider booted and warns that no user provider was registered, which is
  the symptom a misplaced or missing `AuthProvider` produces.

All four trace back to the same shape: configuration is a value one provider
constructs and another provider (or the framework) must find already bound, so
the two providers' relative position is part of the configuration.

### What the CLI pays for it

`guren check` and the deploy verdicts read configuration from source text,
because the configuration is not a value anything can ask for.
`packages/cli/src/session-config.ts` anchors on a `SessionConfig` *type
annotation* (`:14`, `:56-71`) and follows `??`/`||` to recover a fallback
literal (`:87-104`); `deploy-runtime.ts:337-376` builds its session verdict from
that reading; `sessions-check.ts:27-35` decides whether the binding provider is
registered with a `\bClassName\b` regex over `src/app.ts`, because "a config file
with no provider leaves sessions on the in-memory default"
(`add-session.ts:66-71`). A config shape change moves all three.

## Prior art (read 2026-09-15)

**AdonisJS 6** (`start/env.ts`). `Env.create(APP_ROOT, { PORT: Env.schema.number(), NODE_ENV: Env.schema.enum([...]) })`
validates on import of that file, "implicitly before the application boots",
and raises `E_INVALID_ENV_VARIABLES`; the schema also drives the static type of
`env.get()`. Config files under `config/` export `defineConfig(...)` from the
package that owns the concern (`@adonisjs/session`, `@adonisjs/lucid`), and the
package's provider reads it. The scaffolding codemods expose
`defineEnvValidations()`, which appends rules to `start/env.ts` and never
overwrites an existing key.

**Laravel 13** (`config/*.php`, `env()`, `config()`). `env('APP_DEBUG', false)`
is meant to be called only inside config files; `config('session.driver')`
reads the merged result with dot syntax. After `php artisan config:cache`, the
`.env` file is not loaded and `env()` outside config files returns `null`, which
is how Laravel enforces "env is read in one place". There is no schema: a
missing variable is `null` and the default argument is the only guard.

Guren differs from Adonis in two places the design below explains: validation
runs at boot, not import (§1), and `NODE_ENV` cannot be a schema key (§1,
"Variables that stay raw").

## Proposed Solution

Three rules:

1. **`config/<concern>.ts` default-exports a definition, and `createApp()` is
   what reads it.** A definition is data plus a pure function of the validated
   environment. Importing it does nothing.
2. **The environment is declared once, in `config/env.ts`, and validated at the
   start of `boot()`.** Config definitions receive the validated values; they
   never read `process.env`.
3. **Framework providers bind what config declares, before any app provider
   registers.** An app provider no longer constructs a manager that a framework
   provider must find.

### 1. `defineEnv()` and the `Env` builders (`@guren/server`)

```ts
// config/env.ts
import { defineEnv, Env, type InferEnv } from '@guren/core'

const env = defineEnv({
  APP_KEY: Env.string().secret(),
  APP_URL: Env.url().requiredInProduction()
    .describe('Public base URL. Production host authorization answers only to its hostname.'),
  DATABASE_URL: Env.string().default('postgres://guren:guren@localhost:54322/guren'),
  SESSION_DRIVER: Env.enum(['database', 'cookie', 'memory']).default('database'),
  MAIL_FROM_NAME: Env.string().allowEmpty().default('Guren'),
  SMTP_PORT: Env.port().default(587),
})

export default env

declare module '@guren/core' {
  interface AppEnv extends InferEnv<typeof env> {}
}
```

Builders: `string`, `url`, `number`, `port`, `boolean` (`true`/`false`/`1`/`0`),
`enum(values)`, and `custom(schema)` for a Standard Schema validator (zod 4
implements it). Each takes `.optional()`, `.default(v)`, `.allowEmpty()`,
`.secret()`, `.describe(text)` and `.requiredInProduction()`. No dependency is
added to `@guren/server`.

Semantics that remove the `??` class of defect by construction:

- **A blank value is unset.** `FOO=` and an absent `FOO` are the same input to
  every builder, so `.default()` applies to both. `.allowEmpty()` is the explicit
  opt-out, for the display-name case `auth/config/mail.ts:12` disables the lint
  rule for today.
- **Coercion happens in the builder.** `Env.port()` rejects `''`, `abc` and
  `70000`; no config file calls `Number()` on an env string again.
- **`.requiredInProduction()`** is required when `process.env.NODE_ENV ===
  'production'`, written in exactly that form inside `@guren/server` so the
  deploy plugins' `--define` folds it. Its inferred type stays `T | undefined`.
- **`.secret()`** values are never echoed: not in the validation error, not in
  `guren env:example`, not in RFC 0026's manifest.
- **`custom()` is synchronous.** A validator whose `validate()` returns a
  Promise fails `env.parse()` with a message naming the key, because the parser
  also runs inside synchronous callers (the CLI, a connection thunk).

#### Variables that stay raw `process.env` reads

| Variable | Why it must stay a raw read |
|---|---|
| `NODE_ENV` | The deploy plugins pass `--define 'process.env.NODE_ENV="production"'`, and a define matches one exact expression (`.claude/rules/common-pitfalls.md`, Security Defaults and Serverless Bundling). `isMcpEndpointEnabled()` (`packages/server/src/mcp/endpoint.ts:20-26`) and `isDocsViewerEnabled()` are production gates only because that read folds at bundle time. Routing it through the parsed env turns both back into runtime reads, which on workerd reopens them. |
| `GUREN_*` (`GUREN_MCP`, `GUREN_DOCS`, `GUREN_ALLOW_UNVERIFIED_PEER`, `GUREN_TESTING`, `GUREN_INTROSPECT`) | Security gates and framework tooling flags. Declaring one in an app schema would put a `GUREN_MCP=` line in a committed `.env.example`, the hazard `RESERVED_ENV_PREFIX` (`plugin-manifest.ts:62`) already refuses for plugins. |

`@guren/server` exports this rule once, as `isRawEnvKey(key)`. `defineEnv()`
refuses any key it matches, synchronously and with the reason in the message,
and the lint rule in §7 carries a copy that a test pins to the export (the
oxlint plugin is plain JavaScript and does not import the framework). Reads
outside an application stay out of scope rather than on the list: `HOST`/`PORT`
in `bin/serve.ts` run before `createApp()` is imported, and `DATABASE_URL` in
`drizzle.config.ts` is drizzle-kit's.

#### One parser, and when it runs

Everything that evaluates the schema calls one function:

```ts
env.parse(source?: Record<string, unknown>, options?: { mode?: 'throw' | 'report' }): ParsedEnv
// ParsedEnv: { values: AppEnv; problems: EnvProblem[]; unset: ReadonlySet<string> }
```

It looks up each *declared* key (`source[key] ?? process.env[key]`, string
values only) rather than copying `process.env`, ~~and memoizes the result per
source object in a `WeakMap`~~. **Amended in implementation:** no memo.
`process.env` keeps its identity while tests and platforms change its values, so a
cache keyed on the source object returns stale values; a parse is one lookup and
one coercion per declared key. In `report` mode an unset required key is
`AGENT_REDACTED` (`packages/server/src/agent/redact.ts:16`, the placeholder the
agent audit already prints) and is listed in `unset`. **Amended in
implementation:** report mode guarantees that the parse reports rather than
throws; each definition's `resolve` still runs on the placeholder and may throw
on it. The callers:

| Caller | Source | Mode |
|---|---|---|
| `ConfigServiceProvider.register()` (§3) | the `env.source` binding when bound, else `process.env` | `throw`; `report` under `GUREN_INTROSPECT=1` |
| The CLI's config loader (§6) | `process.env` (Bun has loaded `.env`) | `report` |
| A connection thunk run outside an application (§2) | `process.env` | `throw` |

Validation runs in `ConfigServiceProvider.register()`, which is the first
provider `Application` registers (**Amended in implementation:** Part 0 registers
it only when `createApp()` receives `env`, so an app without a schema keeps its
provider list unchanged; Part 1 extends the condition to `config`), so it is the first thing `boot()` does
(`registerAll()` is `Application.ts:773`). Not at import: on Workers,
`bootWorkersApp()` calls `captureWorkersEnv(env)` and only then `app.boot()`
(`packages/plugin-cloudflare/src/boot.ts:48-51`), and the scaffold's own
`config/session.ts` already warns against anything that can throw while the
module evaluates (`templates/scaffold/session/config/session.ts:4-6`).

`@guren/server` cannot import `@guren/plugin-cloudflare`, so the plugin binds
the captured env on the app its generated entry already imports, before boot:
`app.container.instance('env.source', env)` under a `container.has()` guard. This
is the injection shape RFC 0023's Open Question 4 settled for
`inertia.ssrRenderer`. ~~`TestApp.create({ env })` binds the same key.~~
**Amended in implementation:** `TestApp.create({ env, envSource })`. `env` means
what it means in `createApp()`, the schema, and `envSource` is what binds
`env.source`; one name for both would make a test's `env: { APP_URL: ... }`
type-check against neither.

A `throw` failure lists every problem, secrets redacted:

```
[guren] Invalid environment (3 problems, declared in config/env.ts):
  APP_KEY         required, not set
  SMTP_PORT       "abc" is not a port
  SESSION_DRIVER  "redis" is not one of: database, cookie, memory
```

The validated values are bound as `env` (`ServiceBindings['env']: AppEnv`).
There is no ambient `env()` or `config()` helper: `this.make('env')`,
`getRequestContainer(ctx).make('env')`, and `defaultContainer().make('env')`
for the residue, exactly the RFC 0023 §3 forms.

Under `GUREN_INTROSPECT=1`, each problem becomes a `ManifestWarning`
(`code: 'env-invalid'`). Definitions are resolved against a proxy over
`values` that records which keys each `resolve()` reads, and a definition that
read a key in `unset` is not bound: its manifest section is marked unverified
and every other section is produced normally. Binding it would hand the
placeholder to a manager constructor that validates it, as `SessionManager`
does for its default store (`session-manager.ts:120`).

#### Plugins declare env in the manifest only

`guren plugin` reads `package.json` and never executes plugin code
(`plugin-manifest.ts:5-9`), so the manifest is the one place a plugin can
declare env. `GurenPluginEnvEntry` gains optional `type` (a builder name),
`choices`, `required`, `default` and `secret`. On install, `guren plugin` keeps
appending to `.env.example` as today and, when the app has a `config/env.ts`,
also inserts `KEY: Env.<type>()...` into its `defineEnv({...})` object with
`addCreateAppOption(file, key, source, 'defineEnv')` (`patch-helpers.ts:660`,
which already takes the call name and skips a key that is present) plus
`ensureNamedImports` (`:614`). The app's schema is then the complete schema, and
there is no runtime merge. A `guren plugin` from before Part 2 reads only `key`,
`value` and `comment`, and behaves as it does today. **Amended in
implementation:** `type` names any builder but `custom`, whose validator is not
data; `required` and `secret` must be booleans; a `port` default is checked
against the port rule, since `.default()` stores its value unchecked. Every
string reaches `config/env.ts` through the codegen emitters' single-quote
escaping, and the entries are inserted in one write, in manifest order.
`EnvVar` exposes `defaultValue` and `choices` for `guren env:example`; the
builder name and presence stay internal, as nothing reads them.

### 2. `defineConfig()` and the per-concern definitions

```ts
// config/session.ts
import { defineSessionConfig } from '@guren/core'
import { sessions } from '../db/schema'

export default defineSessionConfig((env) => ({
  default: env.SESSION_DRIVER,
  ttlSeconds: 60 * 60 * 2,
  stores: {
    database: { driver: 'database', table: sessions },
    cookie: { driver: 'cookie' },
  },
}))
```

```ts
// src/app.ts
import env from '../config/env.js'
import database from '../config/database.js'
import http from '../config/http.js'
import session from '../config/session.js'
import mail from '../config/mail.js'

const app = createApp({
  env,
  config: [database, http, session, mail],
  routes: registerWebRoutes,
  providers: [AuthProvider],
})
```

The shapes:

```ts
// @guren/server, config/define.ts
export interface ConfigDefinition<K extends keyof ConfigDefinitions = keyof ConfigDefinitions> {
  readonly key: K
  resolve(env: AppEnv): ConfigDefinitions[K]
  /** Runs in ConfigServiceProvider.register(). Binds; never connects. */
  bind(container: Container, config: ConfigDefinitions[K]): void
  /** Runs in ConfigServiceProvider.boot(), before every other provider's boot. */
  boot?(container: Container, config: ConfigDefinitions[K], env: AppEnv): Promise<void> | void
}

/** Augmentable, like SessionDrivers: core adds `database` and `session`. */
export interface ConfigDefinitions {
  cache: CacheConfig
  http: HttpConfig
  mail: MailConfig
  queue: QueueConfig
  storage: StorageConfig
  oauth: OAuthConfig
}

export function defineConfig<K extends keyof ConfigDefinitions>(definition: ConfigDefinition<K>): ConfigDefinition<K>

// ApplicationOptions gains
readonly env?: EnvSchema
readonly config?: ReadonlyArray<ConfigDefinition>
```

The definition carries its key, so the array needs no second name for it. Two
definitions with one key fail the boot, naming both. The per-concern helpers are
thin `defineConfig` calls exported by the package that owns the manager:

| Helper | Package | `bind` | `boot` |
|---|---|---|---|
| `defineCacheConfig` | server | `cache` ← `createCacheManager(config)` | |
| `defineHttpConfig` | server | `http.hostAuthorization` (§5) | |
| `defineMailConfig` | server | `mail` ← `createMailManager(config, container)` | |
| `defineQueueConfig` | server | `queue` ← `createQueueManager(config)` | |
| `defineStorageConfig` | server | `storage` ← `createStorageManager(config)` | |
| `defineOAuthConfig` | server | `oauth` ← `createOAuthManager()` plus each `providers` entry | |
| `defineSessionConfig` | core | `session` ← `createSessionManager(config)` (`core/src/session-manager.ts:27`, which adds the `database` driver) | |
| `defineDatabaseConfig` | core | `database` ← the `createPostgresDatabase(...)` result | `configureOrm({ env })`; `seedDatabase()` when `seedOnBoot` |

`SessionConfig`, `CacheConfig` and the rest are unchanged: a definition's
`resolve` returns exactly the object an app passes to `createSessionManager()`
today. The resolved objects are not bound as a whole; RFC 0026's manifest, if
it lands, is the first consumer that would need them, and it can add that
binding.

RFC 0020 rejected `createApp({ session: sessionConfig })` for two reasons
(`rfcs/0020-pluggable-session-drivers.md:629-632`): `createApp` lives in server
and cannot resolve the `database` driver, and the container binding is the seam
plugins need. Both still hold, and this design keeps both. `config` takes a
*definition*, whose `bind` for `session` is written in core and calls core's
`createSessionManager`, so server never names the `database` driver; and what
the definition produces is the same `session` container binding, made earlier
than any app provider could make it.

`OAuthConfig` is new and small, `{ providers: Record<string, OAuthProviderConfig> }`,
so the blog's conditional registration becomes data:
`providers: env.OAUTH_GITHUB_CLIENT_ID ? { github: createGitHubOAuthProviderConfig({...}) } : {}`.

`config/database.ts` keeps its module-level database object, because app code
imports its named exports (`getDatabase` in `web/app/Services/DocSearchService.ts:10`,
`configureOrm` in `examples/agents/db/seeders/001_OperatorSeeder.ts:6`) and so
does `db-migrate.ts`. Its connection thunk therefore cannot close over a
validated env, and today's `ConnectionResolver` takes no argument
(`packages/orm/src/postgres.ts:11`), nor does `configureOrm()` (`:194`).
`@guren/orm` widens both, additively: the resolver becomes
`(context?: { env: AppEnv }) => string | undefined`, and `configureOrm(context?)`
passes the context it receives to it. `defineDatabaseConfig`'s `boot` calls
`configureOrm({ env })`, so a `TestApp.create({ env })` override reaches the
connection, and a caller outside an application gets `undefined`:

```ts
// config/database.ts
import env from './env.js'

const database = createPostgresDatabase({
  connectionString: (context) => (context?.env ?? env.parse().values).DATABASE_URL,
  // ...
})
export const { getDatabase, migrateDatabase, configureOrm, seedDatabase } = database
export default defineDatabaseConfig(database, { seedOnBoot: process.env.NODE_ENV !== 'production' })
```

**Amended in implementation:** each factory keeps the context `configureOrm()`
received rather than passing it through, because the resolver also runs inside
memoized flights (migrations, the connection) and admin clients that no
`configureOrm()` argument reaches. When a setting that already resolved
resolves differently under the new context, the factory closes the open handle
and drops the migrations memo, so a connection opened before boot cannot keep
naming the wrong database. Without an env schema, `defineDatabaseConfig` passes
no context, so the resolver's own fallback runs.

Behaviour stays in providers. Broadcast channel authorization, event listeners,
schedules, notification channels and `auth.useModel(User, ...)` are closures and
class references, not configuration, and keep their providers.

#### What `config/` may contain

After this RFC a file directly under `config/` is `env.ts` or a module
default-exporting a `ConfigDefinition`, which may also carry named exports
(`database.ts`). `guren check` reports anything else as
`config.not-a-definition`, advisory.

### 3. `ConfigServiceProvider` and provider order

`Application`'s constructor registers `ConfigServiceProvider` first, before
`AuthServiceProvider` (`Application.ts:570-576`). With `ProviderManager`'s
existing two phases (`ServiceProvider.ts:95-117`), that single position gives:

```
register: Config (parse env, resolve + bind every definition) → Auth → Authorization
          → I18n → Error → app providers and module providers, in array order
boot:     Config (each definition's boot: configureOrm, seeding) → Auth (session middleware) → … → app providers
```

No new phase and no dependency graph. Every service a definition binds exists
before any app provider's `register()` runs, which is also what RFC 0020 §2
relies on for a plugin that calls `container.make('session').registerDriver(...)`
from its `register()` (`rfcs/0020-pluggable-session-drivers.md:428-432`). The
ORM connects in `boot()`, never `register()`, which RFC 0026 §2's "No database"
guard depends on.

Two mechanism changes keep the ordering from resurfacing:

- **`Container.singletonIf(key, factory)`**, which binds only when `key` is
  unbound. Every framework default provider binds through it: `Cache`, `Mail`,
  `Queue`, `Storage`, `OAuth`, `Broadcast`, `Notification`, `Health`,
  `Scheduling`, `Event`, `Log`, `Authorization` and `Error`, the thirteen with no
  guard at all today, and `EncryptionServiceProvider`'s `encrypter`, which sits
  beside the one hand-written guard in the directory
  (`EncryptionServiceProvider.ts:14`, for `app.keyring`). A test over
  `packages/server/src/providers/` fails a default provider that binds any other
  way, so the next default cannot reintroduce the "listed later, overwrites the
  app's manager" defect. This does not add an ownership rule beside
  `hasUserProviderOf()` (`Application.ts:586-593`): that function still decides
  whether a default *provider class* is registered, and `singletonIf` only stops
  a registered default from overwriting a binding.
- **A key configured twice is a boot error.** `ConfigServiceProvider` hands
  `ProviderManager` the keys it bound. After each later provider's `register()`,
  `registerAll()` compares those keys' bindings with the ones Config made, through
  a new `Container.bindingOf(key)` (`getBindings()`, `Container.ts:281`, returns
  keys only, and a rebind keeps the key). The work is the configured keys times
  the providers, and the error names the provider:
  `"session" is configured twice: config/session.ts and SessionProvider.register(). Keep one.`
  **Amended in implementation:** the comparison covers eager registration only.
  A deferred provider's `register()`, a provider's `boot()` and `options.boot`
  are not compared; moving ownership into `Container` would cover them, and is
  left until an app needs it.

`DOUBLE_SESSION_CONFIG` (`AuthServiceProvider.ts:10-12`, thrown at `:76`) stays
a separate check. It compares a `createApp()` option (`auth.sessionOptions.store`)
with the `session` binding, where nothing is bound twice and the binding
comparison above cannot see it.

Measured against the blog, the provider list drops from 18 entries to 11:
`DatabaseProvider`, `SessionProvider`, `CacheProvider`, `StorageProvider`,
`OAuthProvider`, `CoreOAuthServiceProvider` and `CoreStorageServiceProvider`
become config files, and `EventServiceProvider` stops constructing the mail and
queue managers. No remaining pair's relative order changes behaviour: the one
that did, `BroadcastProvider` rebinding `broadcast` after
`CoreBroadcastServiceProvider`, is settled by `singletonIf`, and
`NotificationProvider` resolves `mail` in `boot()`, after every `register()`.

**A general ordering mechanism is out of scope, and deliberately not a separate
RFC yet.** `static after = [OtherProvider]` with a topological sort would be a
second source of order beside the array. It becomes worth an RFC when an app
provider pair remains whose order matters after this migration; the blog and
every scaffold blueprint have none, and the scaffolds are what apps copy.

### 4. Where the imperative code in `config/` goes

There is no `bootstrap/` directory. Laravel's `bootstrap/app.php` is framework
bootstrapping, not a home for app code, and a third place for imperative code
beside providers and `src/app.ts` repeats the problem this RFC removes. Each
current resident has a destination:

| Today | After |
|---|---|
| `config/app.ts` `bootModels()` | `defineDatabaseConfig(database, { seedOnBoot })` in `config/database.ts`; `app/Providers/DatabaseProvider.ts` and `config/app.ts` are deleted |
| `config/inertia.ts` side effect | `createApp({ inertia: { share: (ctx) => ({...}) } })`, which `Application` passes to `shareInertiaProps(fn, this.container)` (`shared.ts:171`), the scoped form RFC 0023 already made the replacement for the deprecated `setInertiaSharedProps` (`:145`) |
| `config/attachments.ts` `configureAttachments()` + `morphMap` | `app/Models/Attachment.ts`. The call defines the `Attachment` model the app imports, so it is a model definition, not configuration; `AttachmentsProvider.register()` keeps `engine.bindTo(this.container)`. `attachments-check.ts` is unaffected: it already scans `config/`, `src/` and `app/` for the call (`discovery.ts:548-555`) |

`bootModels()` is not one function today, and `defineDatabaseConfig` covers the
common case rather than all three:

| App | `bootModels()` behaviour | After |
|---|---|---|
| `templates/default` | Always `configureOrm()`; seeds outside production when migrations exist (`config/app.ts:29-38`) | `defineDatabaseConfig(database, { seedOnBoot: process.env.NODE_ENV !== 'production' })`. `configureOrm()` always, as `common-pitfalls.md` requires ("models need a DB connection"); seeding still skips when the folder holds no migrations. **Amended in implementation:** through a new `hasMigrations()` on each factory, which reads files only; `migrationStatus()` opened an admin connection on every boot and throws on D1 |
| `examples/blog` | Skips `configureOrm()` entirely when no migration folder exists (`:32-35`) | Adopts the template behaviour; the blog always has migrations |
| `web/` | `isWorkersRuntime()` branch, and swallows a `configureOrm()` failure with a warning (`web/config/app.ts:10-12`, `:43-54`) | Keeps its own `DatabaseProvider`. Swallowing a connection failure is an app decision a config flag should not offer |

### 5. Host authorization is configuration

Host authorization depends on `APP_URL`, so it moves to a definition like any
other env-dependent setting, rather than `createApp()` growing a function form
per option:

```ts
// config/http.ts
import { defineHttpConfig } from '@guren/core'

const exclude = ['/health']

export default defineHttpConfig((env) => ({
  hostAuthorization: process.env.NODE_ENV !== 'production'
    ? { allowedHosts: ['localhost:*', '127.0.0.1:*'], exclude }
    // Unreachable in production, where `.requiredInProduction()` failed the boot; it narrows the type.
    : env.APP_URL ? { allowedHosts: [`${new URL(env.APP_URL).hostname}:*`], exclude } : false,
}))
```

`createApp({ hostAuthorization })` with an object is unchanged. When `config`
contains an `http` definition, the constructor still mounts host authorization
first (`mountSecurityDefaults()`, `Application.ts:542`), as a placeholder that
reads the `http.hostAuthorization` binding, the same placeholder shape
`AuthServiceProvider.register()` uses for the session middleware
(`AuthServiceProvider.ts:35-38`). A request reaching it before boot is refused
with 503 rather than passed, and giving both forms fails the boot. A future
env-dependent option (trusted proxies, CSP report URIs) joins `HttpConfig`
instead of adding a placeholder of its own. **Amended in implementation:** with
one option, Part 1 binds only `http.hostAuthorization`. When a second arrives,
bind the resolved `HttpConfig` whole and have the one placeholder build the
ordered middleware list.

With `APP_URL` declared `.requiredInProduction()`, a production app with no
`APP_URL` fails its boot instead of disabling the check, so the template's
warn-and-disable branch and its Workers comment go away. The blog's
`secureCookies` (`examples/blog/src/app.ts:32`) combines `NODE_ENV` and `CI`, a
monorepo test artifact the `common-pitfalls.md` E2E section documents; it stays
a module-scope raw read.

### 6. The CLI reads config by importing it

A definition is side-effect free and its `resolve` is a pure function of
`AppEnv`, so the CLI can compute a config without booting. The CLI already
imports the app's routes, controllers and models (`load-routes.ts`), so this
adds no new category of exposure.

`loadResolvedConfig(cwd)` runs once per CLI process and is handed to every
consumer, the way `check.ts:395-397` loads the route graph once for four checks
so two loads cannot disagree. It imports `config/env.ts`, calls
`env.parse(process.env, { mode: 'report' })`, imports each definition file, and
calls `resolve` through the same read-recording proxy as introspection. A config
file whose import fails, or whose `resolve` throws on a placeholder, yields
`evidence: 'none'` and `warn` for its concern (the rule RFC 0026 §5 set) and
never aborts the run.

All producers emit one shape, `Partial<{ [K in keyof ConfigDefinitions]: ConfigDefinitions[K] }>`,
and each verdict is written once against it:

| Producer | Used for |
|---|---|
| `loadResolvedConfig()` | New-shape apps, from Part 2 |
| `session-config.ts`, returning the same shape from the AST | The legacy `SessionConfig`-annotated object only |
| RFC 0026's manifest | Introspectable apps, if and when it lands; the other two become its fallback |

| Consumer | Today | After Part 2 |
|---|---|---|
| `sessions-check.ts` binding rule | `\bSessionProvider\b` regex over the entry (`:27-35`) | Generic `config.unwired`: a `config/<key>.ts` default-exporting a definition that the entry's `createApp({ config: [...] })` array does not reference. Built from `resolveAppEntry` (`provider-registrar.ts:16`), `objectLiteral`/`propertyValue` (`ast-walk.ts:100`, `:171`) and `defaultExportConfigProperty` (`:113`), for every concern |
| `sessions-check.ts` table rule | AST reading of `stores.database.table` | resolved `stores[*].table`, checked with drizzle's `getTableName()` against the schema export list |
| `deploy-runtime.ts` session and cache verdicts | `session-config.ts` AST reading (`:337-376`) | resolved `default` and `stores[*].driver`. When the proxy shows `default` came from an `Env.enum` key, the verdict re-resolves with each value of that key alone, others at their defaults, so it judges every store the schema admits at a cost linear in the enum's size |

**Amended in implementation (Part 2c).** Four corrections, each measured:

- **The read-recording proxy did not exist.** §2 and this section both describe
  it as if it did. `recordEnvReads()` (`@guren/server`) is it, and
  `ConfigServiceProvider` now resolves through it: a definition that read a key
  the environment does not set is left unbound, which is what §2 claimed. Under
  `throw` mode no declared key can be unset, so it only fires under introspection.
- **`defaultExportConfigProperty` cannot read an app entry.** It requires the
  default export to *be* the call, while every shipped entry writes `const app =
  createApp({ … })` and exports `app` further down. A rule built on it would
  report every correct app as unwired. The check walks for the `createApp` call
  instead, as `deploy-runtime.ts` already does.
- **Both rules judge only what the `config: [...]` array names.** A `config/`
  directory today holds plain modules (`config/database.ts`, `config/inertia.ts`),
  so "not a definition" is a finding only for a file the array lists. An array the
  scan cannot read (`config: definitions`) is not evidence and reports nothing.
  `config/env.ts` is the schema the definitions resolve against, never one of them.
- **The keys are `config-unwired` and `config-not-a-definition`**, since every
  other check key in the codebase is dash-separated.

**Deferred past Part 2c**, because no app has a definition to read until the
templates migrate in the next part: rewiring `sessions-check.ts` and
`deploy-runtime.ts` onto the resolved config, with the `getTableName()` table rule
and the enum re-resolution. `getTableName` needs a packaging change first, since
`drizzle-orm` is not a `@guren/cli` dependency and `@guren/orm` exposes no subpath
reaching it, and a resolved table is a live object from the app's own drizzle copy.
The deploy-runtime *cache* verdict this table implies exists in no form today, so
it is new work rather than a swap.

### 7. `.env.example`, drift, and lint

- **`guren env:example`** maps the schema to `GurenPluginEnvEntry` records
  (`describe()` as the comment, the default as the value, secrets blank, enum
  choices appended to the comment) and writes them with `applyEnvEntries()`
  (`plugin-manifest.ts:266`), which gains a `files` option so it can leave `.env`
  alone. Keys the file already has keep their line, and the line-break guard
  (`assertEnvEntriesAllowed`) covers a multi-line `describe()` text as it covers
  a plugin comment. **Amended in implementation:** the schema's entries go
  through the pure append step `applyEnvEntries` now wraps, not through the
  plugin guard, which would refuse the app's own multi-line `describe()`; each
  line becomes a comment line. `$` is written `\$`, because Bun expands `$NAME`
  inside either quote style, and a line counts as assigning its key wherever
  Bun would read it (`export KEY=`, indented). There is no `files` option.
- **`guren check --env`** fails when `.env.example` and the schema disagree on
  the set of keys. **Amended in implementation:** a `config/env.ts` that cannot
  be imported fails the check too, rather than warning about a comparison it
  never made.
- **`guren/no-unvalidated-env-read`**, an oxlint rule beside
  `guren/no-nullish-env-default` that shares its `envKey()` matcher
  (`nullish-env-default.js:12`), reports a `process.env.X` read in `app/`,
  `config/`, `routes/` or `src/` where `X` is not a raw key (§1). It ships through
  `@guren/cli/oxlint` like its sibling. The blog's `CI` read carries a disable
  with its reason. **Amended in implementation:** the rule reports wherever it
  is enabled, and the scaffolds scope it with `overrides` on `app/**`,
  `config/**`, `routes/**`, `src/**` and `modules/*/**`. A first-segment test
  inside the rule missed module code and depended on the directory oxlint ran
  from; `overrides` globs resolve against the config file.
- **Blueprints** (`add-session.ts:111-117`, `add-cache.ts:25-28`, the `mail`,
  `queue` and `storage` blueprints in `packages/cli/src/blueprints.ts`) add their
  keys to `config/env.ts` through `addCreateAppOption(file, key, source,
  'defineEnv')`, the call §1 adds to `guren plugin`, then run `guren env:example`.
  `appendEnvEntry()` (`env-registrar.ts:15`) keeps writing `.env`, the local copy
  the generator does not own. An app with no `config/env.ts` gets today's
  behaviour unchanged.

### Implementation plan

Referencing `RFC 0027` in each PR:

0. **Environment** (`@guren/server` minor, `@guren/plugin-cloudflare` minor,
   `@guren/testing` minor). `defineEnv`, `Env`, `InferEnv`, `env.parse()`,
   `isRawEnvKey()`; `ConfigServiceProvider` with the env half only;
   `createApp({ env })`; the `env` and `env.source` keys; the introspection
   report mode; `inertia.share`. The plugin binds `env.source`.
   `TestApp.create({ env })`. Additive.
1. **Definitions** (`@guren/server`, `@guren/core` and `@guren/orm` minors).
   `defineConfig`, `ConfigDefinitions`, the eight helpers, the definition half of
   `ConfigServiceProvider`, the `http.hostAuthorization` placeholder,
   `Container.singletonIf()` and `bindingOf()`, the twice-configured error, the
   default providers moved to `singletonIf`, the optional context on
   `ConnectionResolver` and `configureOrm()` in every dialect factory. Core gets
   a changeset (the allowlist rule). **Amended in implementation:** shipped as
   three stacked PRs: 1a (`singletonIf` and the default providers, I18n included
   so the source-level rule has no exception), 1b (definitions, `bindingOf`, the
   twice-configured error, the placeholder) and 1c (the ORM context,
   `hasMigrations()` and `defineDatabaseConfig`).
2. **Scaffolds and CLI** (`@guren/cli` minor, `create-guren-app` minor). Templates
   `default`, `default-ssr`, `api-only`, `blog`; scaffold blueprints `session`,
   `cache`, `mail`, `queue`, `storage`, `oauth`, `auth` (its `config/mail.ts`),
   `attachments` (the file move); `guren env:example`; `guren check --env`,
   `config.unwired`, `config.not-a-definition`; `loadResolvedConfig()` and the
   legacy reader's shape; `guren/no-unvalidated-env-read`; the manifest env
   fields in `guren plugin`. `examples/blog`, `api`, `agents` (its
   `config/env.ts` bindings interface renames to `config/bindings.ts`) and `web/`
   migrate. `audit:starter-template` and all three starter smokes run, per the
   pre-PR list. **Amended in implementation:** the configuration guide
   (`docs/en` and `docs/ja`) lands here rather than in Part 0, beside the
   templates it describes; Part 0 documents its API through JSDoc and the
   changeset.

## Alternatives Considered

**Keep providers as the config readers, add only an env schema.** Solves
validation and the `??` defect, and none of the order coupling or the inert
config file: `config/session.ts` would still do nothing unless a provider
imports it, which is the state `sessions-check` exists to detect.

**Discover `config/*.ts` from the filesystem.** Removes the explicit `config`
array, so a file's presence would be what activates it. Rejected for the same
reason provider discovery is a deploy-runtime verdict today: Workers, Lambda and
Vercel bundles have no directory to list. A codegen variant
(`.guren/config.gen.ts` importing every file) is bundle-safe, but it is a
generated artifact the running app depends on, the stale-artifact class
`common-pitfalls.md` warns about, and an API-only app without Vite would rely on
a manual `guren codegen` for its sessions to exist.

**Validate env at import, as Adonis does, or read a module-scope `env` in plain
config objects.** Both evaluate before Workers populates the values (§1), and
both make importing a config file throw in the CLI on a clone without `.env`.

**Declare plugin env on the provider (`static env`) and merge at boot.** A
second declaration beside the manifest, which install time must keep because it
cannot run plugin code, plus a merge and conflict rule and a test helper to keep
the two in agreement. Writing the manifest entries into `config/env.ts` at
install gives one declaration.

**A string-keyed `config('session.default')` accessor.** Laravel's form. Untyped
at the key, and an ambient helper beside the container rule RFC 0023 just
established.

**Use zod for the env schema.** Guren apps already use zod, but `@guren/server`
does not depend on it, and the semantics that matter here (blank is unset,
coercion from strings, secret redaction, production-only requirements) would be
re-implemented on top of it anyway. `Env.custom()` accepts a Standard Schema,
so a zod refinement is one call away.

## Migration Path

Nothing is removed and nothing is deprecated, so no app has to change.

- `SessionConfig`-typed objects passed to `createSessionManager()` from an app
  provider keep working, and so do `CacheProvider`-style providers. The one new
  failure mode is an app adopting a `session` definition *and* keeping a
  `SessionProvider`, which fails its boot with the twice-configured error naming
  both.
- **Behaviour change in Part 1:** a framework default provider listed after the
  app provider of the same subsystem no longer overwrites the app's binding.
  Every such app was running on an empty default manager; the changeset names the
  thirteen providers.
- **Behaviour change for adopters of Part 2's template:** a production boot
  without `APP_URL` fails instead of disabling host authorization with a warning.
  Existing apps keep their `src/app.ts`.
- Adoption is manual, guided: `guren doctor --next` detects a legacy
  `config/session.ts` + `SessionProvider` pair, a config-constructing
  `CacheProvider`/`QueueProvider`/`StorageProvider`/`MailProvider`, and
  `config/app.ts`'s `bootModels`, and prints the new file with the values the old
  one declared. It is not a `guren upgrade` codemod: those are keyed to
  deprecations (`contributing/deprecation-policy.md`), and this RFC introduces
  none.
- Versioning: minors only (`@guren/server`, `@guren/core`, `@guren/orm`,
  `@guren/cli`, `@guren/testing`, `@guren/plugin-cloudflare`,
  `create-guren-app`). No major is required. RFC 0024 proposes merging server
  into core at 3.0.0; the symbols here move with the rest of server's surface and
  change nothing about that plan.
- Deprecating the legacy shape (and with it `session-config.ts`) is a later
  decision, taken once RFC 0026's manifest makes the static readers
  unnecessary for both shapes.

## Open Questions

1. **Regenerating a hand-edited `.env.example`.** §7 keeps existing lines and
   appends, so a comment the app wrote survives and a stale `describe()` text is
   never updated. An ownership marker (`# guren:env-example start`) would let the
   generator own a block.
   **Decision:** no marker. `guren env:example` appends and reports; a marker is
   added only if an app asks for rewritten comments.
2. **Typed access outside providers.** `this.make('env')` in a controller is
   typed through `AppEnv`, but it returns the whole object. Should `Controller`
   gain `this.env` as a shorthand?
   **Decision:** no. A controller reading env directly is the pattern §2 moves
   into config, and a shorthand would invite it.
