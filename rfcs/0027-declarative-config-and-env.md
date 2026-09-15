# RFC: Declarative Config and a Validated Environment

**Author:** 7nohe
**Date:** 2026-09-15
**Status:** Draft

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
| `config/database.ts` | Helpers the CLI imports (`db-migrate.ts:7-10`, `:129`) and `config/app.ts` calls | Named exports, no side effect |

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
throws `Session store not found` on boot (`session-manager.ts` constructor), a
missing `OAUTH_GITHUB_CLIENT_SECRET` silently skips the provider
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
check fails *open* on the one runtime where it cannot see the value yet. The
blog adds `secureCookies` at module scope (`examples/blog/src/app.ts:32`).

### Provider order carries meaning that only prose records

`examples/blog/src/app.ts:66-85` lists 18 providers. Their order is load-bearing
in ways the array cannot show:

- `SessionProvider` must bind in `register()`, not `boot()`, because
  `AuthServiceProvider.boot()` builds the session middleware around that binding
  before any app provider boots. Two comments say so
  (`examples/blog/app/Providers/SessionProvider.ts:5-6`,
  `packages/server/src/providers/AuthServiceProvider.ts:15-19`), and a boot-time
  error exists for the neighbouring mistake of configuring sessions twice
  (`AuthServiceProvider.ts:10-12`, thrown at `:76`).
- Every `Core*ServiceProvider` entry must precede the app provider of the same
  subsystem. `CacheServiceProvider.register()` binds `cache` unconditionally
  (`providers/CacheServiceProvider.ts:6-8`); listed after `CacheProvider`, it
  replaces the app's configured manager with an empty default. `MailServiceProvider`
  documents the dependency in prose (`MailServiceProvider.ts:4-10`: "The
  scaffolded `MailProvider` rebinds `mail`").
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

What Guren takes: Adonis's schema and boot-time validation, Adonis's
"the owning package defines the config type and its provider reads it", and
Laravel's rule that env is read by config definitions and nowhere else. What it
does not take: validation at import (the Workers constraint above), and a
string-keyed `config('a.b')` accessor (untyped, and RFC 0023 settled that
services are resolved from the container, not from ambient helpers).

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

Builders: `string`, `url`, `number`, `integer`, `port`, `boolean`
(`true`/`false`/`1`/`0`), `enum(values)`, and `custom(schema)` for any Standard
Schema validator (zod 4 implements it), each with `.optional()`, `.default(v)`,
`.allowEmpty()`, `.secret()`, `.describe(text)` and `.requiredInProduction()`.
No dependency is added to `@guren/server`.

Semantics that remove the `??` class of defect by construction:

- **A blank value is unset.** `FOO=` and an absent `FOO` are the same input to
  every builder, so `.default()` applies to both. `.allowEmpty()` is the explicit
  opt-out, for the display-name case `auth/config/mail.ts:12` disables the lint
  rule for today.
- **Coercion happens in the builder.** `Env.port()` rejects `''`, `abc` and
  `70000`; no config file calls `Number()` on an env string again.
- **`.requiredInProduction()`** is required when `process.env.NODE_ENV ===
  'production'`, written in exactly that form inside `@guren/server` so the
  deploy plugins' `--define` folds it (see "Variables that stay raw" below).
- **`.secret()`** values are never echoed: not in the validation error, not in
  `guren env:example`, not in RFC 0026's manifest.

`defineEnv()` refuses, synchronously and with the reason in the message, any key
named `NODE_ENV` or starting with `GUREN_`.

#### Variables that stay raw `process.env` reads

Four families are deliberately outside the schema, and the RFC names them so an
implementation does not "finish the job":

| Variable | Why it must stay a raw read |
|---|---|
| `NODE_ENV` | The deploy plugins pass `--define 'process.env.NODE_ENV="production"'`, and a define matches one exact expression (`.claude/rules/common-pitfalls.md`, Security Defaults and Serverless Bundling). `isMcpEndpointEnabled()` (`packages/server/src/mcp/endpoint.ts:20-26`) and `isDocsViewerEnabled()` are production gates only because that read folds at bundle time. Routing it through `env.NODE_ENV` turns both back into runtime reads, which on workerd reopens them. |
| `GUREN_MCP`, `GUREN_DOCS`, `GUREN_ALLOW_UNVERIFIED_PEER` | Security gates read by framework code, opt-in by design; declaring them in an app schema would put a `GUREN_MCP=` line in a committed `.env.example`, the exact hazard `RESERVED_ENV_PREFIX` (`plugin-manifest.ts:62`) refuses for plugins. |
| `GUREN_TESTING`, `GUREN_INTROSPECT` | Set by the framework's own tooling (`TestApp`, `DefaultHasher.ts:17`; RFC 0026 §2), never by an app. |
| `HOST`, `PORT` in `bin/serve.ts`; `DATABASE_URL` in `drizzle.config.ts` | Read by a process that has no `Application` (the listener before `createApp()` is imported; drizzle-kit). `bin/serve.ts` may call `env.parse()` (below) instead, but nothing requires it. |

#### When validation runs, and against what

Validation runs in `ConfigServiceProvider.register()` (§3), which is the first
provider `Application` registers, so it is the first thing `boot()` does
(`registerAll()` is `Application.ts:773`). Not at import:

- On Workers, `bootWorkersApp()` calls `captureWorkersEnv(env)` and only then
  `app.boot()` (`packages/plugin-cloudflare/src/boot.ts:48-51`). Import-time
  validation would run before either.
- The scaffold's own `config/session.ts` already warns that "the values below
  are read when this object is built, so keep anything that can throw (a
  required-env helper) out of it" (`templates/scaffold/session/config/session.ts:4-6`).

The source is `process.env` overlaid with the container key `env.source`
(`Record<string, unknown>`; only string values are read), when bound.
`@guren/server` cannot import `@guren/plugin-cloudflare`, so the plugin binds it
on the app its generated entry already imports, before boot:
`app.container.instance('env.source', env)` under a `container.has()` guard. This
is the same injection shape RFC 0023's Open Question 4 settled for
`inertia.ssrRenderer`. `TestApp.create({ env })` binds the same key.

A failure throws one error listing every problem, secrets redacted:

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

`env.parse(source = process.env)` returns the same validated object without an
application, for the two callers that run outside one: `config/database.ts`'s
connection thunk, which `guren db:migrate` calls with no app booted, and an
optional `bin/serve.ts`.

Under RFC 0026's `GUREN_INTROSPECT=1`, validation reports instead of throwing:
each problem becomes a `ManifestWarning` (`code: 'env-invalid'`), unset required
keys resolve to a redacted placeholder, and every config section computed from
one is marked unverified. A CI job introspecting a fresh clone without secrets
therefore still gets a manifest.

#### Plugins and app providers declare env on the provider

```ts
export class DynamoSessionProvider extends ServiceProvider {
  static env = { DYNAMO_TABLE: Env.string() }
  register() { /* ... */ }
}
```

`Application` merges every registered provider's `static env` into the app
schema before validating. Identical specs for one key are deduplicated; differing
specs are a boot error naming both providers, unless `config/env.ts` declares
the key itself, which wins.

The plugin manifest keeps its `env` entries, and the two declarations cannot be
merged into one. `guren plugin` reads `package.json` and never executes plugin
code (`plugin-manifest.ts:5-9`); that is a security property, so install time
cannot read a class field. `GurenPluginEnvEntry` gains optional `type`,
`required` and `secret` fields, used to write a better `.env.example` line, and
`definePlugin`'s test helpers gain `assertManifestEnv(Provider, manifest)`, which
a plugin runs in its own test suite. The agreement is verified where both
declarations are code the author owns, not in the app.

### 2. `defineConfig()` and the per-concern definitions

```ts
// config/session.ts
import { defineSessionConfig } from '@guren/core'
import { sessions } from '../db/schema'

export default defineSessionConfig(({ env }) => ({
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
import session from '../config/session.js'
import mail from '../config/mail.js'

const app = createApp({
  env,
  config: { database, session, mail },
  routes: registerWebRoutes,
  providers: [AuthProvider],
})
```

The shapes:

```ts
// @guren/server, config/define.ts
export interface ConfigContext { env: AppEnv }

export interface ConfigDefinition<K extends keyof ConfigDefinitions> {
  readonly key: K
  resolve(context: ConfigContext): ConfigDefinitions[K]['config']
  /** Runs in ConfigServiceProvider.register(). Binds; never connects. */
  bind(container: Container, config: ConfigDefinitions[K]['config']): void
  /** Runs in ConfigServiceProvider.boot(), before every other provider's boot. */
  boot?(container: Container, config: ConfigDefinitions[K]['config']): Promise<void> | void
}

/** Augmentable, like SessionDrivers: core adds `database` and `session`, a plugin may add its own. */
export interface ConfigDefinitions {
  cache: { config: CacheConfig }
  mail: { config: MailConfig }
  queue: { config: QueueConfig }
  storage: { config: StorageConfig }
  oauth: { config: OAuthConfig }
}

export function defineConfig<K extends keyof ConfigDefinitions>(
  definition: ConfigDefinition<K>,
): ConfigDefinition<K>

// ApplicationOptions gains
readonly env?: EnvSchema
readonly config?: { [K in keyof ConfigDefinitions]?: ConfigDefinition<K> }
```

`createApp({ config: { cache: session } })` fails to type-check, because the
definition carries its key. The per-concern helpers are thin `defineConfig`
calls exported by the package that owns the manager:

| Helper | Package | `bind` | `boot` |
|---|---|---|---|
| `defineCacheConfig` | server | `cache` ← `createCacheManager(config)` | |
| `defineMailConfig` | server | `mail` ← `createMailManager(config, container)` | |
| `defineQueueConfig` | server | `queue` ← `createQueueManager(config)` | |
| `defineStorageConfig` | server | `storage` ← `createStorageManager(config)` | |
| `defineOAuthConfig` | server | `oauth` ← `createOAuthManager()` plus each `providers` entry | |
| `defineSessionConfig` | core | `session` ← `createSessionManager(config)` (`core/src/session-manager.ts:27`, which adds the `database` driver) | |
| `defineDatabaseConfig` | core | `database` ← the `createPostgresDatabase(...)` result | `configureOrm()`; `seedDatabase()` when `seedOnBoot` |

`SessionConfig`, `CacheConfig` and the rest are unchanged: a definition's
`resolve` returns exactly the object an app passes to `createSessionManager()`
today. The resolved record is bound as `config`
(`ServiceBindings['config']: Readonly<Partial<ResolvedConfigs>>`), which is what
RFC 0026's manifest reads (§6).

`RFC 0020 rejected `createApp({ session: sessionConfig })` for two reasons
(`rfcs/0020-pluggable-session-drivers.md:629-632`): `createApp` lives in server
and cannot resolve the `database` driver, and the container binding is the seam
plugins need. Both still hold, and this design keeps both. `config.session`
takes a *definition*, whose `bind` is written in core and calls core's
`createSessionManager`, so server never names the `database` driver; and what
the definition produces is the same `session` container binding, made earlier
than any app provider could make it.

`OAuthConfig` is new and small, `{ providers: Record<string, OAuthProviderConfig> }`,
so the blog's conditional registration becomes data:
`providers: env.OAUTH_GITHUB_CLIENT_ID ? { github: createGitHubOAuthProviderConfig({...}) } : {}`.

Behaviour stays in providers. Broadcast channel authorization, event listeners,
schedules, notification channels and `auth.useModel(User, ...)` are closures and
class references, not configuration, and keep their providers.

#### What `config/` may contain

After this RFC a file directly under `config/` is one of: `env.ts` (the schema),
a module default-exporting a `ConfigDefinition`, or a module of named data
exports that tooling imports (`database.ts`'s `migrateDatabase` and friends,
which `db-migrate.ts` requires, stay as named exports beside the default).
`guren check` reports anything else as `config.not-a-definition`, advisory.

### 3. `ConfigServiceProvider` and provider order

`Application`'s constructor registers `ConfigServiceProvider` first, before
`AuthServiceProvider` (`Application.ts:570-576`). With `ProviderManager`'s
existing two phases (`ServiceProvider.ts:95-117`), that single position gives:

```
register: Config (validate env, resolve + bind every definition) → Auth → Authorization
          → I18n → Error → app providers and module providers, in array order
boot:     Config (each definition's boot: configureOrm, seeding) → Auth (session middleware) → … → app providers
```

No new phase and no dependency graph. Every service a definition binds exists
before any app provider's `register()` runs, which is also what RFC 0020 §2
relies on for a plugin that calls `container.make('session').registerDriver(...)`
from its `register()` (`rfcs/0020-pluggable-session-drivers.md:428-432`).

`configureOrm()` stays in a `boot()`. RFC 0026 §2's "No database" guard depends
on the scaffold connecting from `DatabaseProvider.boot()` and never from
`register()`; `defineDatabaseConfig` preserves that split (bind in register,
connect in boot) and the table above records it.

Two changes keep the ordering from resurfacing:

- **A framework default provider binds only when its key is absent.**
  `CacheServiceProvider`, `MailServiceProvider`, `QueueServiceProvider`,
  `StorageServiceProvider`, `OAuthServiceProvider`, `BroadcastServiceProvider`
  and `NotificationServiceProvider` guard their binding with
  `if (!this.container.has(key))` (`Container.ts:135`). A default is by definition
  what applies when nothing else was bound, so this does not add an ownership
  rule beside `hasUserProviderOf()` (`Application.ts:586-593`): that function
  still decides whether a default *provider class* is registered, and this guard
  only stops a registered default from overwriting a binding. It also fixes the
  misordered case today, where `CoreCacheServiceProvider` listed after
  `CacheProvider` discards the app's manager.
- **Configuring one key twice is a boot error.** `ProviderManager.registerAll()`
  records, per provider, the container keys whose binding its `register()`
  changed (a snapshot of `Container` binding identities before and after, through
  a new read-only `Container.bindingOf(key)`). RFC 0026 §2 wants the same
  per-provider capture for `register: 'ran' | 'threw'`, so one mechanism serves
  both. When a key bound by `ConfigServiceProvider` was rebound by an app
  provider, `ConfigServiceProvider.boot()` throws:
  `"session" is configured twice: config.session in createApp() and SessionProvider.register(). Keep one.`
  `DOUBLE_SESSION_CONFIG` (`AuthServiceProvider.ts:10-12`) becomes the special
  case of this rule for `auth.sessionOptions.store`, and keeps its message.

Measured against the blog, the provider list drops from 18 entries to 11. Seven
go: `DatabaseProvider`, `SessionProvider`, `CacheProvider`, `StorageProvider`,
`OAuthProvider`, `CoreOAuthServiceProvider` and `CoreStorageServiceProvider`
become `config/database.ts`, `session.ts`, `cache.ts`, `storage.ts` and
`oauth.ts`. `EventServiceProvider` stays but stops constructing the mail and
queue managers, which move to `config/mail.ts` and `config/queue.ts`. The
remaining eleven (`ErrorServiceProvider`, `InertiaServiceProvider`,
`CoreAuthServiceProvider`, `AuthProvider`, `CoreNotificationServiceProvider`,
`NotificationProvider`, `CoreBroadcastServiceProvider`, `BroadcastProvider`,
`EventServiceProvider`, `SchedulingProvider`, `AttachmentsProvider`) contain no
pair whose relative order changes behaviour once the default providers guard
their bindings. `BroadcastProvider` rebinding `broadcast` after
`CoreBroadcastServiceProvider` is the pair the guard settles;
`NotificationProvider` resolves `mail` in `boot()`, after every `register()`.
`AttachmentsProvider` stays because `bindTo()` is behaviour (§4).

**A general ordering mechanism is out of scope, and deliberately not a separate
RFC yet.** `static after = [OtherProvider]` with a topological sort would be a
second source of order beside the array. It becomes worth an RFC when an app
provider pair remains whose order matters after this migration; the blog and
every scaffold blueprint have none, and the scaffolds are what apps copy.

### 4. Where the imperative code in `config/` goes

There is no `bootstrap/` directory. Laravel's `bootstrap/app.php` is framework
bootstrapping, not a home for app code, and adding a third place for imperative
code beside providers and `src/app.ts` repeats the problem this RFC removes. Each
current resident has a destination:

| Today | After |
|---|---|
| `config/app.ts` `bootModels()` | `defineDatabaseConfig(database, { seedOnBoot })` in `config/database.ts`; `app/Providers/DatabaseProvider.ts` and `config/app.ts` are deleted |
| `config/inertia.ts` side effect | `createApp({ inertia: { share: (ctx) => ({...}) } })`, which `Application` passes to `shareInertiaProps(fn, this.container)` (`shared.ts:171`), the scoped form RFC 0023 already made the replacement for the deprecated `setInertiaSharedProps` (`:145`) |
| `config/attachments.ts` `configureAttachments()` + `morphMap` | `app/Models/Attachment.ts`. The call defines the `Attachment` model the app imports (`export const { Attachment, engine }`), so it is a model definition, not configuration; `AttachmentsProvider.register()` keeps `engine.bindTo(this.container)`. `attachments-check.ts` is unaffected: it already scans `config/`, `src/` and `app/` for the call (`discovery.ts:548-555`) |

`bootModels()` is not one function today, and `defineDatabaseConfig` covers the
common case rather than all three:

| App | `bootModels()` behaviour | After |
|---|---|---|
| `templates/default` | Always `configureOrm()`; seeds outside production when migrations exist (`config/app.ts:29-38`) | `defineDatabaseConfig(database, { seedOnBoot: process.env.NODE_ENV !== 'production' })`. `configureOrm()` always, as `common-pitfalls.md` requires ("models need a DB connection"); seeding still skips when `migrationStatus()` reports no migrations |
| `examples/blog` | Skips `configureOrm()` entirely when no migration folder exists (`:32-35`) | Adopts the template behaviour; the blog always has migrations |
| `web/` | `isWorkersRuntime()` branch, and swallows a `configureOrm()` failure with a warning (`web/config/app.ts:10-12`, `:43-54`) | Keeps its own `DatabaseProvider`. Swallowing a connection failure is an app decision a config flag should not offer |

`seedOnBoot` is written with the raw `process.env.NODE_ENV` read, per §1.

### 5. `src/app.ts` module-scope reads

`hostAuthorization` accepts a function of the config context:

```ts
hostAuthorization: ({ env }) => process.env.NODE_ENV !== 'production'
  ? { allowedHosts: ['localhost:*', '127.0.0.1:*'], exclude: ['/health'] }
  : { allowedHosts: [`${new URL(env.APP_URL).hostname}:*`], exclude: ['/health'] },
```

An object keeps today's behaviour exactly. For a function, the constructor
still mounts host authorization first (`mountSecurityDefaults()`,
`Application.ts:542`), as a placeholder that `ConfigServiceProvider.register()`
fills, the same placeholder shape `AuthServiceProvider.register()` uses for the
session middleware (`AuthServiceProvider.ts:35-38`). A request reaching the
function form before boot is refused with 503 rather than passed. With `APP_URL` declared
`.requiredInProduction()`, a production app with no `APP_URL` fails its boot
instead of disabling the check, so the template's warn-and-disable branch and its
Workers comment go away.

The blog's `secureCookies` (`examples/blog/src/app.ts:32`) combines `NODE_ENV`
and `CI`, a monorepo test artifact the `common-pitfalls.md` E2E section
documents. It stays a module-scope raw read, and so does anything else that
reads only `NODE_ENV`.

### 6. The CLI reads config by importing it

A definition is side-effect free and its `resolve` is a pure function of
`AppEnv`, so the CLI can compute a config without booting: import
`config/env.ts`, build a context from the schema (each key's default, and a
redacted placeholder for a required key with none), import `config/<key>.ts`,
call `resolve`. The CLI already imports the app's routes, controllers and models
(`load-routes.ts`), so this adds no new category of exposure. It is the
canonical reading of new-shape config from Part 2 on:

| Consumer | Today | After Part 2 |
|---|---|---|
| `sessions-check.ts` binding rule | `\bSessionProvider\b` regex over the entry (`:27-35`) | Generic `config.unwired`: `config/<key>.ts` exports a definition whose key the `createApp({ config })` object in the entry does not contain. One AST reading of one object literal, for every concern |
| `sessions-check.ts` table rule | AST reading of `stores.database.table` | `resolve()`d `stores[*].table`, checked with drizzle's `getTableName()` against the schema export list |
| `deploy-runtime.ts` session and cache verdicts | `session-config.ts` AST reading (`:337-376`) | `resolve()`d `default` and `stores[*].driver`; an `Env.enum` key selecting the store additionally lets the verdict judge every value the schema admits, which the fallback literal never could |
| `session-config.ts` | Canonical | Fallback for the legacy `SessionConfig`-annotated shape only |

There is one canonical path per shape, never two for the same shape: a
definition is read by import, a legacy annotated object by the existing AST
reader. When the import of a config file fails (an app mid-scaffold that does
not compile), the check reports `evidence: 'none'` and `warn`, the rule RFC 0026
§5 already set.

**Relationship to RFC 0026.** This RFC does not depend on it. If 0026 lands
first, `ConfigServiceProvider.register()` is where its register-stage manifest
gets `session`, `cache`, `storage` and `queue`: `SessionEntry.source` gains
`'config'`, read from the `config` binding instead of `SessionManager.describe()`,
and §6's import path becomes the fallback for a failed introspection. If this
RFC lands first, 0026 Part 2 inherits the import path as its static fallback
instead of the AST reader. Either order ends with the same two readers.

### 7. `.env.example` and `guren check --env`

- **`guren env:example`** writes `.env.example` from the merged schema: each
  key with its `describe()` text as a comment, its default (secrets blank), and
  `# one of: a, b, c` for an enum. Keys the file already has keep their line;
  keys the schema lacks are reported, not deleted.
- **`guren check --env`** fails when `.env.example` and the schema disagree on
  the set of keys, and warns (`env.unvalidated-read`, advisory) on a
  `process.env.X` read in `app/`, `config/`, `routes/` or `src/` where `X` is not
  one of the §1 raw families. `guren/no-nullish-env-default` stays, for legacy
  code and for those families.
- **Blueprints** (`add-session.ts:111-117`, `add-cache.ts:25-28`, the `mail`,
  `queue` and `storage` blueprints in `blueprints.ts`) patch the `defineEnv({...})`
  object in `config/env.ts` through a new `addEnvSchemaEntry()` in
  `patch-helpers.ts`, the AST twin of `addCreateAppOption()` (`:660`), and then
  regenerate `.env.example`. `appendEnvEntry()` (`env-registrar.ts:15`) keeps
  writing `.env`, the local copy the generator does not own. An app with no
  `config/env.ts` gets today's behaviour unchanged.

### Implementation plan

Referencing `RFC 0027` in each PR:

0. **Environment** (`@guren/server` minor, `@guren/plugin-cloudflare` minor,
   `@guren/testing` minor). `defineEnv`, `Env`, `InferEnv`, `env.parse()`;
   `ConfigServiceProvider` with the env half only; `createApp({ env })`; the
   `env` and `env.source` keys; provider `static env` merging; the introspection
   report mode; `hostAuthorization` as a function; `inertia.share`. The plugin
   binds `env.source`. `TestApp.create({ env })`. Additive.
1. **Definitions** (`@guren/server` minor, `@guren/core` minor). `defineConfig`,
   `ConfigDefinitions`, the `config` key, the seven helpers, the definition half
   of `ConfigServiceProvider`, `Container.bindingOf()`, the per-provider binding
   capture and the twice-configured error, the `has()` guard in the seven default
   providers. Core gets a changeset (the allowlist rule).
2. **Scaffolds and CLI** (`@guren/cli` minor, `create-guren-app` minor). Templates
   `default`, `default-ssr`, `api-only`, `blog`; scaffold blueprints `session`,
   `cache`, `mail`, `queue`, `storage`, `oauth`, `auth` (its `config/mail.ts`),
   `attachments` (the file move); `guren env:example`; `guren check --env`,
   `config.unwired`, `config.not-a-definition`; the §6 readers;
   `GurenPluginEnvEntry` fields; `addEnvSchemaEntry()`. `examples/blog`, `api`,
   `agents` (its `config/env.ts` bindings interface renames to
   `config/bindings.ts`) and `web/` migrate. `audit:starter-template` and all three
   starter smokes run, per the pre-PR list.

## Alternatives Considered

**Keep providers as the config readers, add only an env schema.** Solves
validation and the `??` defect, and none of the order coupling or the inert
config file: `config/session.ts` would still do nothing unless a provider
imports it, which is the state `sessions-check` exists to detect.

**Discover `config/*.ts` from the filesystem.** Removes the explicit
`config: {...}` object, so a file's presence would be what activates it.
Rejected for the same reason provider discovery is a deploy-runtime verdict
today: Workers, Lambda and Vercel bundles have no directory to list. A codegen
variant (`.guren/config.gen.ts` importing every file) is bundle-safe, but it is a
generated artifact the running app depends on, the stale-artifact class
`common-pitfalls.md` warns about, and an API-only app without Vite would rely on
a manual `guren codegen` for its sessions to exist. An explicit object that
`guren add` patches and `config.unwired` checks keeps the wiring visible in one
file.

**Validate env at import, as Adonis does.** Simpler (no `env.source`, no
placeholder middleware) and wrong on Workers, where the values are not in
`process.env` yet (`build.ts:1355-1358`); it would also make importing any config
file throw in the CLI on a clone without `.env`.

**Config as plain objects reading a module-scope `env` import.**
`export default defineSessionConfig({ default: env.get('SESSION_DRIVER') })`
reads better than a function, and evaluates at import, with the same Workers
problem and the same CLI problem. The function is what makes a definition inert
until boot.

**A string-keyed `config('session.default')` accessor.** Laravel's form. Untyped
at the key, and an ambient helper beside the container rule RFC 0023 just
established. `this.make('config').session` is typed and container-scoped.

**Use zod for the env schema.** Guren apps already use zod, but `@guren/server`
does not depend on it, and the semantics that matter here (blank is unset,
coercion from strings, secret redaction, production-only requirements) would be
re-implemented on top of it anyway. `Env.custom()` accepts any Standard Schema,
so a zod refinement is one call away.

**A `bootstrap/` directory for imperative setup.** Considered as the home for
`bootModels()` and the Inertia shared props. §4 finds a data home for both and
shows the remaining imperative code already has one (providers).

**Declare provider order explicitly (`static after`, phases beyond
register/boot).** Discussed in §3: once config is bound first and defaults guard
their bindings, no first-party provider pair needs it.

## Migration Path

Nothing is removed and nothing is deprecated, so no app has to change.

- `SessionConfig`-typed objects passed to `createSessionManager()` from an app
  provider keep working, and so do `CacheProvider`-style providers. The one new
  failure mode is an app adopting `config.session` *and* keeping a
  `SessionProvider`, which fails its boot with the twice-configured error naming
  both.
- **Behaviour change in Part 1:** a framework default provider listed after the
  app provider of the same subsystem no longer overwrites the app's binding.
  Every such app was running on an empty default manager; the changeset names the
  seven providers.
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
- Versioning: minors only (`@guren/server`, `@guren/core`, `@guren/cli`,
  `@guren/testing`, `@guren/plugin-cloudflare`, `create-guren-app`). No major
  is required. RFC 0024 proposes merging server into core at 3.0.0; the symbols
  here move with the rest of server's surface and change nothing about that
  plan. A third-party plugin that adopts `static env` raises its own
  `compatibility` floor to the Part 0 release.
- Deprecating the legacy shape (and with it `session-config.ts`) is a later
  decision, taken once RFC 0026's manifest makes the static readers
  unnecessary for both shapes.

## Open Questions

1. **`.requiredInProduction()` or a general `.requiredWhen(predicate)`.** The
   predicate form covers staging-only keys, but a predicate over the raw
   environment is exactly the unvalidated read this RFC removes, and it cannot
   be folded by `--define`. Leaning: ship only the production form; revisit on a
   concrete second case.
2. **Regenerating a hand-edited `.env.example`.** §7 keeps existing lines and
   appends, so a comment the app wrote survives and a stale `describe()` text is
   never updated. An ownership marker (`# guren:env-example start`) would let the
   generator own a block. Leaning: no marker until an app asks for rewritten
   comments.
3. **Typed access outside providers.** `this.make('env')` in a controller is
   typed through `AppEnv`, but it returns the whole object. Should `Controller`
   gain `this.env` as a shorthand? Leaning: no; controllers reading env directly
   is the pattern §2 moves into config.
