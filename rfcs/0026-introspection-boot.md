# RFC: Introspection Boot

**Author:** 7nohe
**Date:** 2026-09-11
**Status:** Accepted (2026-09-23 — discussion window shortened, as RFC 0023/0027 were)

## Problem

`CLAUDE.md` says the CLI never boots an app (`packages/cli/src/csrf-exemption-audit.ts`
row: "no CLI command can see it, because nothing in the CLI boots an app"). That is
half true, and the half that is true is the half that hurts.

What the CLI executes today (verified at `30a26e94`):

| Step | Where | Runs user code? |
|---|---|---|
| `import()` of `routes/web.ts` | `packages/cli/src/load-routes.ts:141` | Yes: the routes file, every controller it imports, every model, validator and resource those import, and `@guren/core` |
| `new Router()` + the registrar | `load-routes.ts:150-151` | Yes: the registrar body |
| `import()` of every `modules/*/index.ts` | `load-routes.ts:109`, `:160` | Yes: each module's providers are *imported* (`defineModule({ providers })`), never constructed |
| `createApp()`, `registerAll()` | nowhere | No |
| `boot()`, `listen()` | only `guren dev` (`commands.ts:2248-2289`) | Not for any check |

So `guren check`, `audit`, `doctor`, `context`, `codegen`, `spec:generate` and
`openapi:generate` already pay for evaluating the app's module graph, and stop
one call short of the object that knows the answers: the `Application` whose
constructor registers the providers (`packages/server/src/http/Application.ts:504-590`)
and whose `bootOnce()` runs `registerAll()`, `mountRoutes()`, `bootAll()`
(`Application.ts:741-760`). Everything a provider binds in `register()`, by
contract side-effect free until `boot()` or a request asks
(`packages/server/src/container/ServiceProvider.ts:24-27`), is rebuilt from
source text instead.

### What the gap costs

1. **Controllers are re-found by name.** `Router.definitions()` serialises a
   controller as `{ name: handler[0].name, action }` (`packages/server/src/mvc/Router.ts:723-724`),
   so `parseControllerMethods()` keys bodies on `ClassName.method`, scans
   `app/Http/Controllers` and `modules/*/`, and records a collision when two
   files declare one class name; "last file scanned wins"
   (`packages/cli/src/controller-methods.ts:40`, `:258-265`, `:293-301`). The
   Router held the class object the whole time.
2. **Runtime facts are re-derived from syntax.** `deploy-runtime.ts` (835 lines)
   walks every source file for `new ScryptHasher(...)`, store constructions and a
   `SessionConfig`-annotated object's `driver:` (`:156-192`, `:240-467`) to answer
   three questions a registered app answers by inspection: which hasher the user
   provider holds (`ModelUserProvider.ts:33`, `:56`), which session store is the
   default (`session-manager.ts:93-103`), whether providers were listed or
   discovered (`Application.ts:547-572`). `session-config.ts` (125 lines) and
   `sessions-check.ts` (163) read the same config again; the "is the binding
   provider registered" rule is a `\bClassName\b` regex over `src/app.ts`
   (`sessions-check.ts:23-34`) and `appBindsService()` is a regex for
   `singleton('session'` over every file (`discovery.ts:535-547`).
   `attachments-check.ts` (734 lines) reads `configureAttachments({...})` call
   arguments by AST, while the engine it configures is one
   `setActiveAttachmentEngine()` away (`packages/core/src/attachments/configure.ts:29-40`).
   The scan "reads constructions, not intent" (its own header), which is why
   every verdict there is advisory (`check.ts:580-594`).
3. **Security verdicts come from regexes over blanked bodies.** `guren audit`
   decides "reads the body without validating" and "mutates without auth" with
   `BODY_ACCESS_PATTERN` (`audit.ts:136`), `AUTH_CALL_PATTERN` (`:555`),
   `mutatesRecords()` (`:633`, `controller-methods.ts:213-219`) over source with
   comments and strings blanked (`controller-methods.ts:228`). The middleware half
   already reads the registered definition (`authMiddlewareVerdict`, `audit.ts:115-127`),
   but alias names are opaque strings there: `middlewareNames` carries `'auth'`,
   not what `'auth'` resolves to (`Router.ts:296-301`).
4. **The higher altitude is already proven reachable.** `route-contract-check.ts`,
   `agent-route-check.ts`, `agents-types.ts` and `routes-types.ts` read registered
   definitions (`check.ts:459-466`, `agents-types.ts:12`, `routes-types.ts:34`) and
   the agent-tool derivation is one function shared by runtime and codegen
   (RFC 0016 §2, "Two derivation layers, one core rule"). None of them carries a
   "must match the rule over there" comment, because there is no second rule.

### Numbers

Measured at `30a26e94`, commits since 2026-06-01 touching `packages/cli`:

| Population | Commits | `fix` | `feat` |
|---|---|---|---|
| all of `packages/cli` | 448 | 54 | 128 |
| the six source-scanning modules (`deploy-runtime`, `session-config`, `sessions-check`, `attachments-check`, `audit`, `controller-methods`) | 63 | 5 | |
| the four definition-reading modules (`route-contract-check`, `agent-route-check`, `agents-types`, `routes-types`) | 21 | 2, neither about drift (#515 is a server 422 change, #265 a CodeQL sweep) | |

Other measures of the same tax:

- The CLAUDE.md Key Files table has 12 rows whose description is "the one
  rule / scan / reading / derivation for X". 10 are in `packages/cli`, and 7 of
  those restate a fact the runtime holds (`route-registrar` mirrors what
  `load-routes` resolves; `controller-methods` mirrors how `Router` dispatches;
  `http-methods`; `deploy-runtime`; `session-config` mirrors `SessionManager`;
  `schema-binding` mirrors a drizzle table object; `app-surface`). Each row was
  written after a second copy of the rule drifted.
- Tests pinning the static readings: `tests/check.test.ts` 2,332 lines,
  `tests/audit.test.ts` 2,465, `tests/deploy-runtime.test.ts` 1,496.

## Proposed Solution

An introspection mode on `Application`: register providers, mount routes, never
boot, never listen, never open a socket, and emit one serialisable manifest. The
CLI reads the manifest where it reads source today, and keeps the source scan
only for facts that exist nowhere but in a method body.

### 1. `Application.introspect()` and `AppManifest`

```ts
// @guren/server, Application.ts
async introspect(): Promise<AppManifest>

// @guren/core (re-exported), for providers and app code
export function isIntrospecting(): boolean   // GUREN_INTROSPECT=1, or inside app.introspect() (amended below)
```

`introspect()` runs, in order: `providerManager.registerAll()` (with the
per-provider outcome capture of §2), `mountRoutes()` (`Application.ts:643-660`;
the registrar, `mountModuleRoutes()`, the prototype fixture import), then the
manifest builders. It does not run `options.boot` (`Application.ts:744`: an
arbitrary callback over Hono), does not run `bootAll()`, and never calls
`listen()`. A second call returns the memoised manifest.

```ts
export interface AppManifest {
  schemaVersion: 1
  generatedAt: string
  entry: { file: string; root: string; stage: 'register' }
  runtime: { bun: string | null; node: string | null; platform: string }
  providers: ProviderEntry[]
  modules: ModuleEntry[]
  routes: RouteEntry[]
  middlewareAliases: Record<string, MiddlewareEntry>
  bindings: string[]                      // container keys present after register()
  session?: SessionEntry
  auth?: AuthEntry
  cache?: DriverMapEntry
  storage?: DriverMapEntry
  queue?: DriverMapEntry
  attachments?: AttachmentsEntry
  agentTools: DerivedAgentTool[]          // deriveAgentTools(routes), unchanged
  warnings: ManifestWarning[]
}

export interface ProviderEntry {
  name: string                            // constructor.name (durable: Guren forbids identifier mangling)
  source: 'framework' | 'options.providers' | 'module' | 'discovered'
  module?: string
  deferred: boolean
  provides: string[]
  register: 'ran' | 'introspect-hook' | 'threw' | 'skipped'
  error?: string
}

export interface ModuleEntry {
  name: string; prefix?: string; providers: string[]; commands: string[]; routeCount: number
}

export interface ControllerRef {
  name: string; action: string
  file: string | null                     // project-relative; null when identity matching failed
  exportName: string | null               // 'default' or the named export
  resolved: 'identity' | 'name-only'
}

export interface MiddlewareEntry {
  kind: 'alias' | 'group' | 'inline'
  name: string | null
  members?: string[]                      // for 'group'
  capabilities: MiddlewareCapabilities    // the existing RFC 0007 shape
  ability?: string                        // when the middleware declares one (see §3)
}

export type RouteEntry = Omit<RouteDefinition, 'schemas' | 'controller' | 'middlewareNames'> & {
  module: string | null
  controller?: ControllerRef
  middleware: MiddlewareEntry[]           // scoped, then route-local; aliases resolved
  schemas: Partial<Record<'params' | 'query' | 'body' | 'output', JsonSchema | { unreadable: string }>>
}

export interface SessionEntry {
  source: 'manager' | 'auth.sessionOptions.store' | 'none'
  default: string
  stores: Record<string, { driver: string | null; table?: string; perProcess: boolean | null }>   // amended below
}

export interface AuthEntry {
  guards: string[]; defaultGuard: string | null
  providers: Record<string, { kind: string; model?: string; hasher: string }>   // hasher: constructor.name; amended below
}

export interface DriverMapEntry { default: string; entries: Record<string, { driver: string }> }

export interface AttachmentsEntry {
  configured: boolean
  table?: string; disk?: string
  delivery?: { mode: 'stream' | 'redirect'; routeName: string; mounted: boolean }
}

export interface ManifestWarning { code: string; message: string; provider?: string; route?: string }
```

Each optional section is present exactly when its container key exists after
`registerAll()` (`Container.has()`, `Container.ts:134`). The managers gain one
read-only method each so the manifest never resolves a store:
`SessionManager.describe()` (over the private `configs` map,
`session-manager.ts:96`; the `database` driver's `table` reported through
drizzle's `getTableName()`), `CacheManager.describe()`, `StorageManager.describe()`,
`QueueManager.describe()`, `AuthManager.describe()`, and
`describeActiveAttachmentEngine()` in `@guren/core`. `perProcess` comes from
`BUILT_IN_SESSION_DRIVERS` (amended below).

> **Amended in implementation (Part 1):** the shapes above changed where the
> code they describe differs from what the draft assumed, and each change reports
> `null` rather than a value the manifest cannot know.
>
> - `entry.file` is `string | null`: `Application` does not know which file
>   imported it, so the CLI reader fills it in and an in-process `introspect()`
>   leaves it `null`.
> - `ProviderEntry.source` is `'framework' | 'options.providers' | 'module' |
>   'app.register'`. Nothing in `Application` runs `AutoDiscovery`, so
>   `'discovered'` could never be set; `'app.register'` is a provider added
>   through `Application.register()` after construction.
> - `DriverMapEntry.entries[*].driver` is `string | null`: `null` for an entry
>   registered as a bare factory (`CacheManager.registerStore()`,
>   `StorageManager.registerDisk()`, and every `QueueManager` driver, whose config
>   is factories only).
> - `SessionStoreEntry.driver` and `perProcess` are `null` for an
>   `auth.sessionOptions.store` thunk, which only calling it would answer. With no
>   manager and no explicit store, `source: 'none'` describes the in-memory store
>   the session middleware falls back to.
> - `perProcess` (`boolean | null`) comes from `BUILT_IN_SESSION_DRIVERS`, not
>   `PER_PROCESS_SESSION_DRIVERS`: that map records every framework driver and
>   whether it shares state, so a driver outside it (a plugin's) is `null`. An
>   explicit store's class is mapped to its driver first (`MemorySessionStore` to
>   `memory`, core's `DatabaseSessionStore` to `database`); any other class is
>   `null`.
> - `AuthEntry` gains `hasher`, the one the app writes with, plus `algorithm`
>   (`'scrypt' | 'argon2' | 'bcrypt' | null`) and `requiresBun` (`boolean |
>   null`), because the class name alone hides the answer: `DefaultHasher`
>   writes scrypt, or Bun-only Argon2id with `hasher: 'argon2'`. Both are read by
>   exact constructor: `DefaultHasher` reports its algorithm, `NodeHasher` scrypt
>   without Bun, `ScryptHasher` (exported as `Argon2Hasher`) Argon2id or bcrypt
>   with Bun, and a subclass or an app's own hasher `null` for both, since it may
>   override `hash()`. A provider entry is `{ kind: 'model', model, hasher,
>   algorithm, requiresBun }` for `useModel()` and `{ kind: 'custom', hasher:
>   null, algorithm: null, requiresBun: null }` for a bare `registerProvider()`.
> - `AttachmentsEntry.delivery` is `{ prefix, routeName, mounted }`, and a `disks`
>   map carries each disk's `visibility`, `route` and `serve`. RFC 0015 made the
>   serve mode per disk, so the draft's single `mode` has no source.
> - `MiddlewareEntry` gains `unresolved: true` for a name no alias or group
>   registers, which `definitions()` already skips rather than throws on, and a
>   group entry gains `unresolvedMembers` for members no alias registers.
> - `introspect()` registers routes but does not mount them on Hono or load the
>   prototype fixture: mounting throws on an alias nothing registers, which the
>   manifest reports as `unresolved`, and preparing prototype routes refuses in
>   production. Nothing the manifest describes needs the mount.
> - `isIntrospecting()` is also true inside an in-process `app.introspect()`: the
>   run enters an `AsyncLocalStorage` scope, and `GUREN_INTROSPECT=1` stays the
>   CLI child's way to set it for the whole process. A provider prefers the
>   `introspect?()` hook; `isIntrospecting()` is for a check inside `register()`.
>   Provider constructors run at `createApp()`, before any introspection, so in
>   process they see `false` while the CLI child sees `true`: read the flag inside
>   `register()`, never in a constructor. Timers scheduled inside the run keep
>   reading `true` after it finished.
> - A route registrar that throws fails the whole introspection (`introspect()`
>   rejects, and the CLI reports `crashed`), unlike a provider's `register()`,
>   which is recorded as `threw` while the rest continue. Routes have no
>   per-registrar outcome to record, and a partial route list would read as
>   complete.
> - The manifest is copied into plain JSON before it is returned: `undefined`
>   keys are dropped, so the in-memory manifest equals the `--json` output, and
>   a value JSON cannot carry (a function, a Map, a class instance) throws
>   rather than vanishing. The schema walker omits an all-optional object's
>   `required` instead of setting it to `undefined`.
> - `ConfigServiceProvider` implements `introspect()` itself, parsing the
>   environment in report mode, so an in-process `introspect()` reports env
>   problems the way a CLI run does instead of recording the provider `threw`.
> - Warning codes: `boot-callback-skipped`, `env-invalid` and `config-unverified`
>   (RFC 0027 §1, collected from `ConfigServiceProvider`), `schema-partial`,
>   `agent-tool`, `section-unreadable` (a bound manager whose construction threw),
>   `section-unverified`, `session-configured-twice` (a `session` binding beside
>   `auth.sessionOptions.store`, which the app refuses at boot) and
>   `controller-import`. `section-unverified` covers a
>   section a deferred provider supplies, a key bound to something without
>   `describe()`, and a session left unbound while a provider threw: none of them
>   falls back to `source: 'none'`. A provider that threw makes every unbound
>   section unverified, since the manifest cannot tell which key it would have
>   bound.
> - `introspect()` is terminal. A `boot()` after it refuses, since a provider may
>   have run `introspect()` in place of `register()`, and an `introspect()` after
>   `boot()` refuses too, including a boot that failed part way.
> - The session `database` store's `table` is read through drizzle's
>   `Symbol.for('drizzle:Name')`, the value `getTableName()` returns, because
>   `@guren/server` must not depend on the ORM.

### 2. What introspection must not do

Introspection runs user code, exactly as `load-routes.ts:141` does today; the
new exposure is `src/app.ts` and the providers' `register()` bodies. The guards:

| Guard | Mechanism |
|---|---|
| The flag | The CLI spawns a child with `GUREN_INTROSPECT=1` set before the entry's module graph evaluates. `isIntrospecting()` is the one reader. |
| No boot, no listen | Under the flag, `Application.boot()` itself degrades to `introspect()` and `listen()` throws `Cannot listen under GUREN_INTROSPECT`. This covers an entry that boots at module scope (`bootstrapApplication()` already accepts a `ready` promise, `runtime.ts:90-100`), which `introspect()` alone could not intercept. |
| No database | Every ORM factory defers the connection to `getDatabase()`: `createPostgresDatabase` (`packages/orm/src/postgres.ts:153-173`), `createMysqlDatabase` (`mysql.ts:165-169`), `createSqliteDatabase` (`sqlite.ts:186`), `createD1Database` (`d1.ts:59`), `createAwsDataApiDatabase` (`aws-data-api.ts:63`). Construction is free. The eager step is `configureOrm()`, which awaits migrations and opens a client (`postgres.ts:195-198`, `mysql.ts:202`, `aws-data-api.ts:200`), and the scaffold calls it from `DatabaseProvider.boot()`, never `register()` (`templates/default/app/Providers/DatabaseProvider.ts:7-16`). Stopping before `bootAll()` is the guard. An app that calls `configureOrm()` in `register()` connects; §5's reader reports it as a warning (`provider-connected-in-register`) by watching `@guren/orm`'s active-connection registry, and the verdict for that app stays advisory. |
| Providers with eager side effects | `ServiceProvider` gains `introspect?(): void \| Promise<void>`. When present it runs *instead of* `register()` under the flag and should bind only what `describe()` needs. When absent, `register()` runs unchanged. The scaffolded providers already register thunks (`templates/scaffold/cache/.../CacheProvider.ts:8-20`, `session/config/session.ts`), and `SessionManager`, `CacheManager`, `QueueManager` resolve lazily, so none of them needs the hook. An ioredis client constructed inside `register()` without `lazyConnect` is the shape that does. |
| A `register()` that throws | Recorded as `register: 'threw'` with the message; registration continues so the manifest still describes the rest. Every reader treats a section behind a thrown provider as unverified (§5), never as absent. |
| A `register()` that hangs | The child has a wall-clock cap (default 30 s, `--timeout`). A timeout is a failed introspection, and Part 2's fallback applies. The child loads `.env` the way `guren dev` does and writes nothing. |

> **Amended in implementation (Part 1):** `definePlugin()` gains the same
> `introspect(container, config)` hook, passed through only when a definition
> supplies one, so a plugin without it still runs `register()`. The
> `provider-connected-in-register` warning needs `@guren/orm`'s connection
> registry and lands with the §5 readers in Part 2.

### 3. Controller references and middleware resolution

The Router keeps the handler tuple in its registry (`Router.ts:222`, the class
object in `handler[0]`) and drops it at `definitions()`. Part 1 adds
`Router.registeredHandlers(): ReadonlyArray<{ index: number; controller?: ControllerConstructor; action?: string }>`,
index-aligned with `definitions()`. The manifest builder resolves each class to a
file by identity: it `import()`s every discovered controller file (a cache hit,
since the routes import already evaluated them) and compares exports with `===`.
Two `PostController` classes in two modules are then two `ControllerRef`s with
different `file`s, and `ControllerNameCollision` has nothing to report for routed
controllers. A class whose file the walk does not find (declared inline in the
routes file, say) is `resolved: 'name-only'` with `file: null`, and a body scan
keyed on it stays on the collision-reporting path it has today.

Middleware aliases resolve through the Router's own `middlewareAliases` and
`middlewareGroups` maps (`Router.ts:373-374`), which `definitions()` never
exposes. `MiddlewareEntry.capabilities` reuses `capabilitiesOf()` per handler.
`ability` is filled only when the handler carries it in its capabilities; the
framework's own authorization middleware gains that declaration in Part 1, a
user's middleware may add it, and an absent value means "not determinable", which
`guren audit` reports as it reports an unresolved alias today.

> **Amended in implementation (Part 1):** identity resolution runs in the CLI's
> introspection child, not in `@guren/server`. The child holds the app, walks
> `app.router.registeredHandlers()`, finds controller files through the CLI's
> `discoverControllerFiles()` and compares exports with `===`. A routed class
> that `@guren/core` or `@guren/server` exports (core's delivery controller)
> stays `name-only` and is not searched for. The child imports the app files
> named after a routed class first, and every other controller file only while
> an app class is still unmatched: an unrouted controller's module scope runs
> then, and a timeout there names the file it was importing. The server would
> otherwise restate that discovery rule and import `node:fs` from a module
> Workers bundles. An in-process `introspect()` therefore reports every
> controller `resolved: 'name-only'`. Middleware resolution stays in the Router,
> as `Router.describeMiddleware()` beside `registeredHandlers()`, because the
> alias and group maps are private to it. `ability` is not a new capability
> field: the authorization stamp has carried `abilities` since RFC 0016 §4, so
> `ability` is derived from it by `derivableAbility()`, the rule agent tools
> use too. It is the one ability of a single-ability `all` stamp, or on a route
> entry the verb-map ability of a resource stamp whose `fromMethodMap` holds,
> whose mode is `all`, and that names no ability of its own. The stamp is per entry: a group's merges its
> members', so a group combining a resource check with a named one has none.

### 4. `guren introspect --json`

A new command, additive. Reads the app the way `dev` does (`resolveMainEntry()`,
`runtime.ts:68`; `bootstrapApplication()`, `:90`), runs the child, prints the
manifest. `--json` is the machine form; the default prints the sections as
tables. The CLI-side reader lives in `packages/cli/src/introspect.ts`:

```ts
export type Introspection =
  | { status: 'ok'; manifest: AppManifest }
  | { status: 'failed'; reason: 'no-entry' | 'import' | 'timeout' | 'crashed' | 'old-server'; message: string }

export async function introspectApp(cwd: string, options?: { timeoutMs?: number }): Promise<Introspection>
```

`old-server` is the app resolving a `@guren/server` without `introspect()`; the
reader detects it structurally, as `MaybeApplication` does for `listen()`
(`runtime.ts:15-24`). One introspection per CLI process, memoised, shared by
every check that asks: the same shape as `check.ts`'s `loadRouteGraph()`
(`:168-185`) and `doctor.ts`'s `createManifestPlans()` (`:1248-1256`).

> **Amended in implementation (Part 1):** the child writes its result to a temp
> file named in its argv, never stdout, because the app's modules print there. It
> exits explicitly afterwards, since an app may hold open handles. `old-server` is
> checked before the entry is imported: the child resolves `@guren/core` (then
> `@guren/server`) from the entry and checks `Application.prototype.introspect`.
> A scaffolded `src/main.ts` boots at import, and an older server would ignore
> the flag and run the real boot. `guren introspect` also takes `--app <dir>`
> and `--timeout <s>`. The child runs in its own process group, killed on
> timeout, once it exits, and on SIGINT/SIGTERM/SIGHUP to the CLI. The CLI holds
> the child's stdin open, and the child kills its group when that pipe ends, so
> a helper a `register()` started outlives no death of the CLI, SIGKILL included.
> The child resolves `@guren/core`, then `@guren/server`, the way the entry does
> (ESM conditions): a module that resolves but will not load is `crashed`, and so
> is neither resolving; an old one is `old-server`. Whether a `listen()` call came
> from the entry or from a scanned controller file is recorded when it is made,
> by wrapping `Application.prototype.listen` on that module, not inferred from
> when its rejection arrives: only the entry's `listen()` refusal is `crashed`.
> When no provider binds `attachments`, the child reads core's
> `describeActiveAttachmentEngine()`, the documented fallback the server cannot
> reach. On failure `--json` prints `{ status, reason, message }`
> and the command exits 1. An unhandled rejection other than the entry's
> `listen()` refusal becomes an `unhandled-rejection` warning on an otherwise
> `ok` manifest.

### 5. Who reads the manifest, who stays static

| Module | Today | After Part 2 | Part 3 |
|---|---|---|---|
| `deploy-runtime.ts` | AST scan (`:156-467`) feeding `judgePasswordHashing`, `judgeRuntimeStores`, `judgeProviderDiscovery` (`:661-822`) | 2a: `requiresBun` of `auth.hasher` and `auth.providers[*]`, the selected session store's `perProcess`, a `memory` cache default. Target detection, provider discovery, OAuth state stores, the queue, explicit `Memory*Store` constructions, `autoSession: false`, a `sessionOptions.store` factory and a `useModel()` in `boot()` stay on the scan | Part 3 removed the hasher half (constructions, `auth.hasher`, an unreadable `createApp()` config) and the `SessionConfig` reading: without a manifest the hashing and store verdicts are `-unverified`. Kept, since the manifest does not carry them: target detection, provider discovery, OAuth state stores, explicit `Memory*` constructions, a hand-mounted `createSessionMiddleware`, `autoSession: false`, the backed stores a `sessionOptions.store` factory could build, and the password auth the source shows (`auth.attempt()`, `auth.useModel()`, a `ScryptHasher` construction), which only keeps a manifest with no user provider from passing. `checkDeployRuntime(cwd)` kept its signature |
| `session-config.ts`, `sessions-check.ts` | AST for `SessionConfig`, regex for the binding provider | 2b: `session.source` for the binding; each `database` store's `table` against the tables the schema reader names | Part 3 removed the binding-provider regex (`sessions-binding-unverified` without a manifest) and the `default` reading. The `SessionConfig` finder and each store's `driver` and `table` stay, for a config the app does not read and a missing named export |
| `attachments-check.ts` | AST over `configureAttachments()` arguments, route lookup | 2b: `attachments.{table,disk,delivery}`, `delivery.mounted`, the storage section's driver for a redirect disk | Part 3 removed the delivery rules' route load: without a manifest the mount and the redirect disks are `-unverified`, and a call in `boot()` is judged against the registered routes and storage drivers. Argument parsing stays for that call and for the table, whose missing export fails the introspection; the disk's `root` and `Attachable(...)` detection stay source |
| `controller-methods.ts` | key `ClassName.method`, collisions | 2c: `byExport` and `file#export.method` through `controllerMethodFor()`; a collision is reported only for a class some route reaches by name | Nothing: the name-keyed maps are what a caller that does not introspect reads, and the key `plan:*` judges by |
| `audit.ts` auth/validation | middleware names + body regex | 2c: resolved `middleware[]` with capabilities and `ability`, `schemas.body` presence; the routes file after a failure or a provider that threw | Nothing: a failed introspection leaves the route rules on the routes file, which the audit loads first anyway |
| `audit.ts` raw SQL, secrets, mass assignment, CSRF exemptions | source and `node_modules` scans (`:656-660`, `csrf-exemption-audit.ts`) | unchanged: body-level and dependency-level facts | unchanged |
| `route-contract-check`, `agent-route-check`, `prototype-check` | `loadRouteDefinitions()` | 2d: `manifest.routes`, asked for by content. Params keys come from `properties` and their severity from `required`; the routes file's Zod decides where the rendering is short of the schema | Nothing: `load-routes.ts` is the fallback, and a params schema the walker renders short has only its Zod |
| `agents-types`, `routes-types` (codegen) | `loadRouteDefinitions()` | 2d: the routes file by default. `codegen --introspect` takes the route set from the manifest and each route's Zod from the routes file; `planAgentManifest()` follows codegen's default | Nothing: every renderer reads Zod, and the manifest carries JSON Schema (Decision 5) |
| `doctor.ts`, `context.ts`, `spec-generate.ts` | `analyzeDeployRuntime`, `loadContextRoutes` | 2a and 2d: doctor's deploy section and `prototype-routes`; `guren context` lists the manifest's routes with the routes file's Zod; the spec views stay on the routes file | Nothing: `spec:generate` writes committed files that the in-process gate regenerates without introspecting |
| `docs-check`, `docs-index`, `i18n-check`, `spec-check`, `arch-check`, `audit:prose` | static | static by nature: prose, links, import graphs | |
| `schema-parser`, `schema-check`, `schema-binding` | Drizzle AST | static: the database is never opened, and `db/schema.ts` is data, not behaviour | |
| all `make:*` / `add` scaffolders, `route-registrar` patching, `inflect`, `drizzle-pins` | static | static: they write source, and must run on an app that does not compile yet | |

Fallback rule for Part 2: when `introspectApp()` returns `failed`, every check in
the first five rows runs its current static path and marks the result
`evidence: 'static'`; a check that has no static path reports
`status: 'warn'` with `unverified` in the key; a section behind a provider whose
`register` is `'threw'` is treated the same way. No verdict is ever `pass` on
absent evidence: `CheckResult` gains `evidence: 'manifest' | 'static' | 'none'`.

> **Amended in implementation (Part 2a):** Part 2 ships as four PRs: 2a the
> fallback base and `deploy-runtime.ts`; 2b `session-config.ts`,
> `sessions-check.ts` and `attachments-check.ts`; 2c the `controller-methods.ts`
> key and the `audit.ts` auth and validation half; 2d the route consumers with
> `doctor.ts`, `context.ts` and `spec-generate.ts`.
>
> - `CheckResult.evidence` is optional, set only by the checks that read the
>   manifest. `guren check` and `guren doctor` take `--no-introspect`, which
>   judges from source. A consumer asks for the introspection lazily
>   (`deploy-runtime` once a deploy target is found), so an app no consumer
>   applies to never spawns the child. In process, `runCheck()` and
>   `runDoctor()` introspect only with `introspect: true`: the edit hook, the
>   gate and the dev MCP server read gating results or live for the session,
>   and `introspectApp()`'s per-process memo would outlive the app it read.
>   `checkDeployRuntime(cwd)` introspects by default, as the deploy builds call it,
>   capped at 10 s against the command's 30 s, and the build prints one line
>   naming each verdict's evidence. Only `deploy-runtime` reads the manifest in
>   2a, so the deploy target is the introspection trigger; 2b widens it.
> - A failed introspection adds one advisory `introspection-unavailable` line to
>   `guren check`. `guren doctor` adds no warning for it, since `doctor --strict`
>   would then fail every app whose entry does not import yet (a fresh clone
>   before codegen); its JSON carries `evidence` and an `evidenceReason` that
>   `--no-introspect` leaves out. An `-unverified` verdict is a warning
>   `doctor --strict` counts, like every deploy warning.
> - Any provider that threw makes every section a verdict reads unverified, not
>   only an unbound one: `auth` is bound in the `Application` constructor and
>   `useModel()` runs inside a provider, so a throw before it leaves `auth`
>   described with no providers and the default hasher, which would pass. A
>   config left unbound because it reads an unset environment variable
>   (`config-unverified`, which now carries the config's `key`) makes its
>   section unverified too, checked before the value: an unbound `session`
>   still reads as `source: 'none'`. The rule lives in
>   `packages/cli/src/manifest-section.ts`, for Parts 2b to 2d to share.
> - An unverified section follows the fallback rule above: a check with a static
>   path falls back to it with `evidence: 'static'` and names the reason, since
>   the throw is evidence against the manifest, not against the scan, and most
>   throws are environmental (a provider reaching for a Workers binding). Only a
>   fact with no static path becomes `<check>-unverified` with `evidence:
>   'none'`: in 2a, whether the cache store is per-process. A verdict reading
>   several facts reports the weakest evidence among them.
> - `deploy-runtime` reads what the manifest carries: `requiresBun` of
>   `auth.hasher` and of every `auth.providers` entry (null warns), the session
>   store `default` selects with its `perProcess` (for the manager, a null
>   resolved through an installed plugin's `gurenPlugin.drivers.session`, then
>   warned; an `auth.sessionOptions.store` class is a constructor name no plugin
>   declares, so its null warns as a class the check cannot vouch for), and a
>   `memory` cache default, which the scan never read. Two cases the manifest
>   holds no fact for go back to the scan: an `auth.sessionOptions.store`
>   factory (reported with `driver: null`), and no user provider registered
>   while the source hashes passwords (a `useModel()` in `boot()` is past the
>   register stage). The rest stays on the scan
>   because the manifest does not carry it: target detection; `AutoDiscovery`,
>   since a provider it finds registers as `app.register` exactly as an explicit
>   `app.register(X)` does, and the listeners and jobs it finds are not in the
>   manifest; OAuth state stores; the queue, whose `QueueManager.describe()`
>   reports every driver `null` because its config is factories only; explicit
>   `Memory*Store` constructions (rate limiters, scheduler locks); a hand-mounted
>   `createSessionMiddleware`; and `autoSession: false` beside a bound session
>   manager. Part 3 can delete the extractor only after those facts reach the
>   manifest.
> - `provider-connected-in-register` is deferred again. `@guren/orm`'s
>   `active-connections.ts` keys a client only under `bun --hot` and exports no
>   reader, so there is no registry to watch. It needs a connection registry the
>   ORM exposes, and moves to Part 2b or later.
> - The child loads the app root's `.env`, so a store an environment variable
>   selects is judged at its local value. The deploy verdicts stay advisory for
>   that reason.

> **Amended in implementation (Part 2b):**
>
> - The trigger widens. Besides a deploy target, `guren check` introspects an
>   app with a session config (`SessionConfig`-typed or `defineSessionConfig()`),
>   a `configureAttachments()` call, or an `Attachable(...)` model. Each rule asks
>   for the run's one introspection only after it finds its own content, through
>   `introspectedSection()` in `manifest-section.ts`, and `check.ts` hands the
>   thunk to these rules only when the run's changed files include source; a
>   `--changed` run without one judges from source and says so. blog and web both
>   match, so their CI `guren check` introspects.
> - `sessions-binding` reads `session.source`. `manager` passes. `none`, an
>   absent section (no session middleware at all) and `auth.sessionOptions.store`
>   are the inert-config warning, since in each the config is never read. It
>   still runs for the declared form only: a `defineSessionConfig()` is bound by
>   the `config` array, which `config-unwired` judges. A provider that binds
>   `session` only in `boot()` reads as inert, which is also the runtime verdict:
>   `AuthServiceProvider.boot()` builds the session middleware before any app
>   provider boots. A `session-configured-twice` manifest warning (a manager
>   beside `auth.sessionOptions.store`) is a `sessions-binding` failure for
>   either form, since the app refuses to boot.
> - `sessions-config:*` reads each `database` store's `table` (its SQL name)
>   against the tables the static schema reader names. The key stays the one the
>   scan builds: the config declaring the store and the export it imports, then
>   the local identifier, the SQL name and the store's name. A missing named export is a link
>   error that fails the introspection, so that case stays on the scan. Only a
>   SQL name the reader finds is evidence: it reads each root's `db/schema.ts`
>   and nothing else `drizzle.config` lists, drops a `pgSchema().table()` or a
>   non-literal table, and names a `pgTableCreator()` table without its prefix.
>   So a name it does not find keeps the source verdict when the source traces
>   the table to a schema export, and is otherwise an advisory warning. A value
>   that is not a Drizzle table fails. A config the app does not read has no
>   stores in the manifest, so its tables stay on the scan too.
> - The attachments rules read the engine only when one was configured while the
>   app registered. When the source calls `configureAttachments()` inside a
>   function and the manifest has no engine, every rule judges from source and
>   names that reason: a call in a provider's `boot()` is past the register
>   stage, as a `useModel()` in `boot()` was in 2a. A manifest-only failure there
>   would fail `check --ci` on a working app. The model fails from the manifest
>   only when every call runs whenever its file loads (outside any function,
>   branch, loop, `try` or class field), no source file imports a site through
>   `import()` and the manifest carries no `boot-callback-skipped`: then nothing
>   the app loads while it registers imports the file. `attachments-model:*`
>   passes from the manifest when an engine was configured, including one the
>   scan cannot see.
> - `delivery.mounted` is `Router.hasRoute(routeName)`, a name lookup. The check
>   also requires that route's controller to be the delivery controller, so an
>   app route that only carries the name is not the mount. The duplicate-name
>   rule counts `manifest.routes`.
> - `AttachmentsEntry.disks` carries no driver, so `serve: 'redirect'` is judged
>   against the storage section's `entries[disk].driver`, then against the
>   source's disk declaration when the manager reports none (a disk registered as
>   a factory). Whether a driver presigns is still decided from its name by the
>   CLI's table: `s3` presigns, `local` and `memory` do not, any other name is
>   skipped. Carrying `presignedGet` in the manifest is a separate server change.
> - `attachments-public-disk:*` reads the engine's `disk` and the storage
>   manager's driver, and the disk's `root` from source, which
>   `StorageManager.describe()` does not report. Its evidence is `static` either
>   way.
> - When the manifest judges one config and the source holds others (a second
>   session config, another `configureAttachments()` call's table or redirect
>   disks), the source verdicts for the others are kept under their own keys.
>   The delivery mount is app-wide, so an unmounted route is reported for every
>   config enabling delivery, as the scan does. The manifest does not say which
>   config it describes: a verdict goes to the config whose export the schema
>   names as that table or that literally names the disk, else to the one config
>   there is. A verdict that fits several goes to each (a non-Drizzle session
>   table, to every config declaring the store), and one that fits none is
>   reported under a key naming no file, never dropped.

> **Amended in implementation (Part 2c):**
>
> - `parseControllerMethods()` keeps its name-keyed `methods`, `classFiles` and
>   `collisions` and adds `byExport` (`file#export` to the class, whose action
>   then keys the body: `file#export.method`; one entry per name the file exports
>   the class under: its own, `default`, an `export { X as Y }` alias) and
>   `declarations` (every class, same-named ones included). The file
>   is POSIX-relative, the form the child writes. `controllerMethodFor()` is the
>   one lookup: a reference resolved by `identity` reads its own file, and one
>   the scan cannot place there (the child picked a file that re-exports the
>   class) falls back to the name, as a `name-only` reference does. A placed class
>   that declares no such action, or whose file would not read or parse, has no
>   body, never another class's. A `name-only` reference is evidence too: the
>   router holds a class that is no export of any controller file the app loaded
>   (a framework class, or an app class the child found in no export). So a
>   same-named exported declaration is another class. The route has no body here
>   (`elsewhere`) when the routes file or the entry declares the name, or when
>   no same-named declaration is left: one the file does not export (a
>   controller file routing its own class), or one in a file whose import failed
>   (`controller-import`). The last of those is read by name. A file whose import
>   failed holds the routed class only when the app evaluated that module under
>   another path (a symlink resolved differently), since the app could not have
>   loaded it otherwise. `collisionsReachedByName()` keeps a
>   collision only for a class some route reached by name.
> - `guren audit` reads `manifest.routes` for `validation:*`, `authz:*` and
>   `agent-annotation:*`. It introspects only when the routes file, loaded first,
>   registers a route that is unsafe or carries a body (or fails to load, since
>   the app may still register), never under `--routes`, whose file the manifest
>   does not describe, and in process only with `introspect: true`. A failed run
>   is one `introspection-unavailable` warning, which leaves the exit code alone,
>   and a provider that threw sends the rules back to the routes file: that
>   provider may have registered an alias the manifest would then call unresolved.
>   The report carries `routeSource`.
> - `authz:*` does not pass on authorization alone. `authorizeMiddleware()` stamps
>   only `authorization`, `Gate.resolveUser()` returns `null` for a guest, and a
>   policy is called with that `null`, so an authorizing chain with no
>   `requireAuthenticated()` lets a guest reach a policy that may allow it. It
>   stays a warning whose message says what the chain checks: `ability`, any or
>   all of several, an ability decided at request time, or deny-all. The draft's
>   "unresolved alias" warning splits in two: an alias registered outside the
>   routes file resolves and stops warning, while a name no alias or group
>   registers anywhere is its own warning, judged before any guard beside it,
>   since mounting it throws, and a guard never turns it into a pass. When
>   something introspection skips could register the name, the warning names it
>   instead of stating the boot failure as fact: a skipped `options.boot`, which
>   runs before `mountRoutes()`, or an app provider registered through its
>   `introspect()` hook (an empty hook, as `cloudflarePlugin`'s, included;
>   `ConfigServiceProvider` always runs one, hence `source !== 'framework'`). A
>   provider that threw is not listed: the rules have gone back to the routes
>   file. The auth-like name match reads alias and group entries only, as the
>   static path does.
> - Body validation passes when `schemas.body` is present, `{ unreadable }`
>   included: the live schema validates whatever its JSON Schema reads as.
>   `evidence` follows 2a's weakest-fact rule: `manifest` only for a guard's
>   capability or an enforced body schema, `static` for anything that read a
>   controller body.
> - On the manifest path the force-write rule reads every declaration, since no
>   collision finding covers an unrouted pair any more; a class sharing its name
>   is keyed with its file.
> - `agent-route-check.ts` and `entity-context.ts` keep the registered definitions
>   (moving them to `manifest.routes` is 2d) and take the manifest's references
>   through `attachControllerRefs()`, matched on method, path, class and action,
>   since the manifest lists the whole app's routes in its own order, through the
>   one bridge `withManifestControllerRefs()`, which introspects whenever a route
>   has a controller and marks a name the routes file or entry declares. The
>   agent-route rules ask for it whenever an agent route names a controller
>   (content-activated, like 2b's triggers), so
>   they agree with `guren audit` on a routed class the manifest places
>   elsewhere; `guren check` passes its run's introspection.
>   `generateEntityContext()` takes `introspect: true` and asks only when a route
>   names a class two files declare; the `guren context` command is left to 2d.
> - `plan/app-state.ts` stays name-keyed. A plan element names a class and its
>   module, never a route, and `plan/status.ts` keys action bodies and route
>   wiring by `Class.action` throughout, so a collision stays `blocked` there on
>   either path. Lifting it needs module-qualified action keys in RFC 0030's
>   status reader.

> **Amended in implementation (Part 2d):** the table above records Part 2 as
> shipped, and its last column what Part 3 can remove given what the manifest
> carries.
>
> - `route-contract-check`, `agent-route-check` and `prototype-check` judge
>   `manifest.routes` when `guren check` introspects. Each asks for the run's one
>   introspection only after the routes file shows that rule's own content: the
>   route contracts a params schema or a binding, the agent-route rules an agent
>   route, the prototype rules a fixture or a `prototype` route. So a route a
>   provider or plugin registers is judged by a rule only when the routes file
>   has that rule's content, and a module in `modules/` that `createApp()` never
>   mounts drops out. A
>   provider that threw, a failed introspection, and `--routes` (the manifest
>   describes the entry, as in `guren audit`) send the rules back to the routes
>   file with `evidence: 'static'`.
> - Params keys are the JSON Schema's `properties` (Decision 5), and a key's
>   severity is `required`. The walker's `isOptional(schema, 'input')` and
>   `permitsOmission()` stay two functions, and a test registers one route per
>   wrapper to pin that both paths give every stray key the same severity. The
>   manifest is not used for a route whose params schema it renders short: not an
>   object with `properties` (a nullable object is `anyOf`, and a bare
>   `z.transform()` or `z.preprocess()` a bare `object`; zod 4's `.transform()`
>   is a pipe whose input side keeps its properties), a `schema-partial` note
>   under it, or keys other than the ones the routes file's Zod declares. The
>   routes file's definition of the same route, joined on method, path, name and
>   controller action, then decides (`static`). A route with no such definition
>   and a short rendering is an unreadable warning, never a pass, naming what is
>   known: the note, or that the schema is not an object with properties. A note
>   rejects the whole params schema, even one on a nested value
>   (`z.array(z.any())`) that drops no key.
>
>   The walker also drops keys with no note: `z.undefined()`,
>   `z.undefined().optional()`, a union whose options all render as nothing, a
>   promise with no inner schema. Only the Zod shows those, so on a route with
>   no joined definition they go unseen and its other keys are judged. That
>   covers a route only the app registers, and a routes-file route whose join
>   key the two sides count differently (a provider registering a route
>   identical to one in the routes file, by method, path, name and action).
>   A server walker that noted every drop would close it.
> - Evidence: a verdict that read or looked for a controller body is `static`
>   (agent-route authorization, `readOnlyHint` honesty, the Inertia output
>   finding, the approval-queue scan), and so are `prototype-app-wiring` and an
>   unparsable fixture. Everything read from the route is `manifest`.
> - The agent-route rules introspect whenever the routes file has an agent
>   route, no longer only when one names a controller, since the manifest now
>   supplies the routes themselves.
> - Codegen stays on the routes file by default, and `guren codegen --introspect`
>   (and `routes:types --introspect`) opts in. Three reasons. The Vite plugin runs
>   codegen on every edit to a watched file, and a child process per keystroke is
>   the cost Part 2a kept off the in-process callers. The generated files must
>   not depend on which path wrote them, and the dev MCP server and the Vite
>   plugin never introspect. And every renderer (`schemaToTypeString()`,
>   `schemaPropertyTypes()`, the plugin-ai input types) reads Zod, which the
>   manifest does not carry. So `--introspect` means: the manifest decides which
>   routes exist and in which order, and each route the routes file also
>   registers is rendered from that definition. The two paths write the same
>   bytes when the route sets match and come in the same order: measured on
>   `examples/blog` (29 routes), `web/` (22) and `examples/agents`, every
>   generated file identical. The generators sort by name and path, and the sort
>   is stable, so two routes sharing a name keep their input order; the manifest
>   orders modules as `createApp({ modules })` lists them and the routes file's
>   load by directory, so such an app can differ there. A route only the
>   manifest has is rendered without schema types, with a warning naming it; an
>   agent tool on it comes from `manifest.agentTools`. Tool names are
>   first-wins, as `deriveAgentTools()` is at runtime, where a provider's routes
>   register before the routes file's: the generated manifest keeps the tool the
>   running app exposes, and `guren check` still fails the duplicate. A failed
>   introspection, and a `--routes` file other than the one `check` probes as
>   the entry, write from the routes file and say why; a routes file that fails
>   to load fails as before, since its Zod is required.
> - `--introspect` output is one-shot. The default codegen (the Vite watcher's,
>   the gate's, a plain `guren codegen`) is what every comparer reads, and the
>   next run of it drops the routes only the app registers again (`guren gate`
>   runs `codegen --force` before its check stage, so it never sees
>   `--introspect` output). `planAgentManifest()`, which `check` and `doctor`
>   ask whether `.guren/agents.gen.ts` should exist, follows the default: in an
>   app whose agent tools all come from a provider, a file `--introspect` wrote
>   reads as stale to both, and the `guren codegen` they name removes it. The
>   finding says so. Reading the manifest there instead would not settle it: the
>   callers of `runCheck()` that do not introspect (the edit hook, the dev MCP
>   server, `plan:verify`'s check step) would call the same file stale while
>   `guren check` passed it. The rule asks only whether the file should exist:
>   when the routes file derives tools of its own, a file `--introspect` wrote
>   with a provider's tools as well passes as present, and nothing reports the
>   extra ones.
> - The spec views stay on the routes file, with no flag. `docs/spec/` is
>   committed and drift-gated, and `guren gate` and the edit hook run
>   `runCheck()` in process, which does not introspect (2a). A `spec:generate`
>   that read the manifest would write a `screens.md` the gate regenerates
>   without an app's provider routes and then reports as drift. The outputs match
>   on blog and web; the reason is the second writer, not a measured difference.
> - `guren context` lists the introspected app's routes by default, and
>   `--no-introspect` or `--routes` reads the routes file. Type strings are still
>   rendered from the routes file's Zod, so a provider's route is listed with
>   none, and `controller` keeps its `{ name, action }` shape in `--json`. The
>   dev MCP server's context stays on the routes file. When introspection was
>   asked for and not used (a failure, a provider that threw), the Routes section
>   says why in one line and `--json` carries it as `routesNotIntrospected`, so
>   the SessionStart hook, which drops stderr, still shows it.
>   `guren context <Entity>` passes the flag to `generateEntityContext()`, which
>   introspects only when a route reaches a class two files declare (2c), and
>   never with `--routes`.
> - `guren doctor`'s `prototype-routes` counts the manifest's routes once a
>   routes file passes the `prototype` handler, with `evidence` and, when it read
>   the routes file for a reason, `evidenceReason`. Doctor still adds no warning
>   for a failed introspection.
> - `load-routes.ts` is not a fallback only. It is the Zod source for every
>   renderer on both paths, the path for an app whose entry does not import yet,
>   and what `plan:*`, `openapi:generate`, `route:list`, `tool:list` and the dev
>   MCP server read. The join the Part 2d consumers use lives in
>   `packages/cli/src/app-routes.ts`. Part 2c's `attachControllerRefs()`, which
>   `guren context <Entity>` still reads, joins through the same
>   `joinRouteDefinitions()`, so a route name tells two routes of one method,
>   path and action apart, and a key both sides repeat equally pairs nth to nth.
>   It also passes each definition's `defineModule()` name, which the manifest's
>   `module` holds, so the join pairs within a module: the CLI reads modules in
>   directory order and the app in `createApp({ modules })` order.

> **Amended in implementation (Part 3):** the table above records what Part 3
> removed and what it kept. The last column of the draft read "remove once a
> failed introspection reports those verdicts `-unverified`"; that is now the
> rule for every fallback that only ran on failure, while a source reading that
> supplies a fact the manifest lacks on success stays.
>
> - `guren gate` introspects. Its check and audit stages share one run, started
>   by whichever asks first, through `runCheck({ introspect })` and
>   `runAudit({ introspect })`, which now take a function as well as `true`.
>   The run is not the process memo: `introspectApp(cwd, { fresh: true })`,
>   since the dev MCP server calls the gate for the whole session. codegen is
>   the gate's first stage, so the entry imports on a fresh clone by the time
>   check runs. A failed introspection is one `Introspection (advisory)` finding
>   on the stage that met it and never fails the gate. Every other `-unverified`
>   result (`evidence: 'none'`, `unverifiedResults()` in `check-result.ts`) is
>   printed on the check stage as an advisory line too, and so is it on
>   `plan:verify`'s check step, which records a step `verified` over it: without a manifest `sessions-binding` and `attachments-delivery:*`,
>   which gated before, no longer do, and a provider that threw leaves no
>   `introspection-unavailable` line, so without them a CI run with no `APP_KEY`
>   would pass a dropped session provider or delivery mount in silence.
> - One cap, `CHECK_INTROSPECT_TIMEOUT_MS` (10 s), for every command that judges
>   the app: `guren check`, `audit` and `doctor` (30 s before), the gate,
>   `plan:verify` and the deploy builds. The gate composes the checks CI runs,
>   and an app that registers in 10 to 30 s would otherwise fail `check --ci`
>   and pass the gate, or the reverse. 10 s rather than 30 s because the gate
>   runs on an agent's every stop; `guren introspect --timeout`, `guren context`
>   and `codegen --introspect`, which judge nothing, keep 30 s.
> - A `--changed` run that changed no source file introspects for neither the
>   route rules nor audit (`runAudit({ changedFiles })` applies the rule
>   `runCheck()` does). The deploy verdicts still introspect when `package.json`
>   changed, since a deploy plugin is declared there. `stopGateFindings()`
>   therefore spawns the child on an agent's stop whenever the app has a rule's
>   content (a deploy target, a session or attachments config, a mutating
>   route, an agent route). web and blog introspect in under 0.5 s.
> - `plan:verify` introspects, through the process memo with the gate's 10 s
>   cap. Every verify list opens with a `codegen` that must pass before any later
>   command runs (`PLAN_STEP_VERIFY`, and `stoppedBy` in `plan/verify.ts`), so the
>   check never runs against an entry that cannot import. It runs in one-shot
>   processes (the command, the Stop hook), so the memo is safe there; the dev MCP
>   server never runs `plan:verify`. A Stop hook with a marked plan step therefore
>   spawns two children, the gate's own run and this one, each capped at 10 s.
>   Sharing them would need the shipped `gate-on-stop.ts` to pass one run to both,
>   a template change for one child on the stops of a plan implementation.
> - The dev MCP server's `guren_check` does not. It answers an agent mid-edit and
>   is called far more often than the gate, which the same server exposes as
>   `guren_gate` and which does introspect. The edit hook runs `check --arch`
>   only and reads no manifest.
> - `deploy-runtime.ts`: the hasher constructions (`ScryptHasher`, `Hash({
>   algorithm })`, `NodeHasher`), `createApp({ auth: { hasher } })`, the
>   unreadable-config signal and the `SessionConfig` driver reading are gone.
>   Without a manifest, or with a section it cannot vouch for, the verdicts are
>   `deploy-password-hashing-unverified` and `deploy-runtime-stores-unverified`
>   (`evidence: 'none'`, `evidenceReason` naming why), still listing what the
>   source shows (OAuth, explicit constructions). No user provider registered
>   while the source calls `auth.attempt()` is `-unverified` too, where it used
>   to fall back to the scan, and so is one whose source calls `auth.useModel()`
>   or constructs a `ScryptHasher`: a provider registered in `boot()` is past
>   what the manifest sees, and a hasher built there would otherwise pass as
>   "no password authentication". A `sessionOptions.store` factory the manifest
>   shows is judged by the backed stores the source constructs, whatever the
>   `createApp()` options look like, so the `auth`, `autoSession` and
>   `sessionOptions` keys are no longer read as session signals; only
>   `autoSession: false` and a hand-mounted `createSessionMiddleware` are.
>   `analyzeDeployRuntime()` and
>   `judgeDeployRuntime()` are deprecated (`deploy-runtime-analysis`, removed in
>   3.0.0, a first-use warning), introspect by default like
>   `checkDeployRuntime()` (both with a run of their own, `fresh`, since a
>   long-lived caller must not keep the process memo), and keep `DeployRuntimeAnalysis`'s removed signal
>   fields as empty arrays; the commands call `readDeployRuntime()` and
>   `judgeDeployVerdicts()`.
> - `sessions-check.ts`: `checkBinding()` and its `\bClassName\b` regex over
>   the entry are gone; without a manifest the result is `sessions-binding-unverified`,
>   advisory. The table verdicts stay on source when there is no manifest: a
>   missing named export is a link error that fails the introspection, so the
>   scan is the only reader of the defect the rule exists for.
>   `session-config.ts` no longer reads `default`.
> - `attachments-check.ts`: the delivery rules no longer load the routes file.
>   With the engine in the manifest they read it as before; with a manifest but
>   no engine (a call in `boot()`) the call's options come from source and the
>   mount and drivers from the registered app (`AttachmentsWiring.registered`);
>   with no manifest the mount and each redirect disk are
>   `attachments-delivery-unverified:*` and `attachments-serve-redirect-unverified:*`,
>   advisory. `configureAttachments()` argument parsing stays for the `boot()`
>   case and the table rule. The three `-unverified` builders for check results
>   share `unverifiedResult()` in `manifest-section.ts`.
> - Not changed, against the task list that started Part 3: `controller-methods.ts`
>   still reports every collision on the static path, and `guren audit` still
>   fails it. There every route reaches its class by name, so a collided class's
>   `validation:*` and `authz:*` verdicts may be passes read from the other
>   file's body. The failing collision is what keeps the exit code from passing
>   on that evidence; an advisory `-unverified` would let `guren audit` and the
>   gate pass exactly where the rule above forbids a pass on absent evidence. On
>   the manifest path Part 2c already reports only the collisions a `name-only`
>   reference reaches.
>   Provider discovery, target detection and explicit store constructions stay
>   on the scan because no manifest section carries them; removing them would
>   warn every deploy app whose introspection succeeds.
> - Measured against `9eebeec0`: `deploy-runtime.ts` 1,229 to 1,050 lines,
>   `session-config.ts` 160 to 138, `sessions-check.ts` 289 to 256,
>   `attachments-check.ts` 1,018 to 1,006, `tests/deploy-runtime.test.ts` 2,026
>   to 1,462; `controller-methods.ts` unchanged (654).
> - Verdicts on the reference apps against `9eebeec0`: blog and web report the same
>   keys and statuses through `check`, `check --ci`, `audit`, `doctor` and `gate`.
>   `examples/agents`, whose `EncryptionServiceProvider` throws without
>   `APP_KEY`, reports `deploy-password-hashing-unverified` (advisory) where it
>   passed from source; `check --ci` exits 1 on main and here, on the same
>   non-advisory agent-route warning.

### 6. Enabling refactor: one module per command

`commands.ts` becomes `packages/cli/src/commands/<name>.ts`, one `defineCommand()`
each, plus `commands/index.ts` holding a registry:

```ts
export const COMMANDS: Record<string, () => Promise<{ default: CommandDef }>> = {
  'check': () => import('./check'),
  'introspect': () => import('./introspect'),
  // ...67 entries
}
```

`bin.ts` passes the loaders to citty as lazy `subCommands`, so one invocation
imports one command. Non-breaking: names, flags and output are byte-identical.
It lands before Part 1 so the new command has somewhere to go that is not line 3,421.

### Implementation plan

Referencing `RFC 0026` in each PR:

0. **Split** (§6). `@guren/cli` only; no behaviour change. Its own PR.
1. **Manifest** (§1-§4). `@guren/server`: `introspect()`, the `boot()`/`listen()`
   flag behaviour, `ServiceProvider.introspect?`, `Router.registeredHandlers()`,
   the `describe()` methods, `AppManifest` types, the `ability` capability.
   `@guren/core`: `isIntrospecting()`, `describeActiveAttachmentEngine()`,
   `createSessionManager` unchanged. `@guren/cli`: `introspect.ts`, `guren
   introspect`. Additive; minor releases for server, core (the allowlist rule)
   and cli; `examples/blog` and `web/` produce a manifest in CI.

   **Amended in implementation:** Part 1 ships as three stacked PRs, each
   building and passing its packages' tests on its own.
   - **1a**, `@guren/server`: `introspect()`, the flag behaviour of `boot()` and
     `listen()`, `ServiceProvider.introspect?`, `Router.registeredHandlers()`,
     `describeMiddleware()` and `routeCount`, and the manifest sections that need
     no manager (`entry`, `runtime`, `providers`, `modules`, `routes`,
     `middlewareAliases`, `bindings`, `agentTools`, `warnings`). `@guren/core`
     re-exports `isIntrospecting()`. Controllers are `name-only` until 1c.
   - **1b**: the `describe()` methods and the optional `session`, `auth`,
     `cache`, `storage`, `queue` and `attachments` sections,
     `describeActiveAttachmentEngine()`, `ability` on middleware entries,
     `definePlugin()`'s `introspect` hook, and `@guren/plugin-cloudflare`'s hook.
   - **1c**, `@guren/cli`: `introspectApp()`, the child process with controller
     identity resolution, `guren introspect`, the CI step and the docs.
2. **Consumers** (§5 rows 1-8) with the static fallback and `evidence`. Verdicts
   may change for an app where the source scan guessed wrong; each such change is
   a changeset entry naming the check key.
3. **Retire** the source scans the table marks. `tests/deploy-runtime.test.ts`
   shrinks to the judge functions over manifest fixtures; the CLAUDE.md rows for
   `deploy-runtime`, `session-config` and the collision half of
   `controller-methods` are rewritten to point at the manifest.

   **Amended in implementation:** Part 3 is one PR, `@guren/cli` only, and
   `guren gate` introspecting is part of it (§5, Part 3). The deploy-runtime
   tests that stay on disk judge the scan's remaining facts beside a manifest
   fixture; the ones pinning the removed readings went with them.

> **Amended in implementation:** Part 1 landed before the §6 split, which is
> being done as smaller extractions (`commands/make.ts`, `commands/database.ts`,
> and the diagnostic commands). `guren introspect` lives in
> `commands/introspect.ts` and is registered in `commands.ts` with one import
> and one registry entry.

## Alternatives Considered

**Keep static-only.** The drift tax is the numbers above: 5 fixes in 63 commits
on six modules, 3,246 lines of source and 6,293 of tests whose job is to agree
with a runtime they cannot see, and 12 "the one rule" rows written after a
disagreement. Every advisory verdict in `guren check` is advisory because the
scan "never reads intent". The cost also compounds per feature: RFC 0020 Part 0
had to add a `SessionConfig` reader before the driver existed, and
`attachments-check.ts` grew to 734 lines across RFC 0013 and RFC 0015. A
manifest makes the next feature's check a field lookup.

**Full boot, including `listen()`.** Rejected. `bootAll()` runs
`configureOrm()` through the scaffolded `DatabaseProvider`, which migrates and
connects; a check that needs a database is not a check that runs in CI on a
fresh clone. `listen()` needs Bun and a port.

**A build-time manifest from the Vite plugin.** The route-types plugin already
spawns the CLI on changes to `routes/web.ts`, pages and resources
(`packages/cli/src/vite/route-types.ts:14-22`, `:47`) and is off under `CI`
(`:40`). It could write `.guren/manifest.json` on every regeneration. A cache
of Part 1 at most, not a replacement: an API-only app has no Vite, CI skips the
plugin, and a manifest on disk is the stale-artifact class `common-pitfalls.md`
warns about. If it ships, `introspectApp()` prefers a live run.

**Reuse the MCP endpoint.** `/_guren/mcp` runs inside a booted app, but its
tools (`create-mcp-server.ts:212-510`) call the CLI's static scans, and it needs
`GUREN_MCP=1` plus a listening server. A transport, not a source of facts.

## Migration Path

Internal for the most part:

- `Application.introspect()`, `isIntrospecting()`, `ServiceProvider.introspect?`,
  `Router.registeredHandlers()` and the `describe()` methods are additive. A
  provider written before this RFC introspects through its `register()`
  unchanged.
- `boot()` under `GUREN_INTROSPECT=1` stops before `bootAll()`. Nothing sets that
  variable today; a user who exports it in a shell and runs `guren dev` sees the
  `listen()` refusal name the variable.
- User-visible changes are limited to a check whose verdict moves because the
  manifest contradicts the scan (a `SessionStore` passed as `store:` that the
  scan read as unbacked becomes `pass`; a `configureOrm()` in `register()`
  becomes a warning). Each is listed in the Part 2 changeset under the check key.

  > **Amended in implementation (Part 2a):** a `SessionStore` of the app's own
  > passed as `store:` does not become `pass`. The manifest reports
  > `perProcess: null` for a class outside the framework's map, and the fallback
  > rule forbids a pass on absent evidence, so it stays a warning that now names
  > the class. `configureOrm()` in `register()` is not reported yet (§5).
- `loadRouteDefinitions()` is not deprecated: it is the static fallback and the
  path for a scaffold mid-generation whose `src/app.ts` does not import yet.
- No deprecation is introduced, so `deprecations.ts` and `codemods.ts` are
  untouched. Changesets: `@guren/server` minor, `@guren/core` minor,
  `@guren/cli` minor for Part 1; `@guren/cli` minor for Parts 0, 2, 3.

  > **Amended in implementation (Part 3):** one deprecation is introduced.
  > `analyzeDeployRuntime()` and `judgeDeployRuntime()` from `@guren/cli` are
  > `deploy-runtime-analysis` in `deprecations.ts` (since 2.28.0, removed in
  > 3.0.0, replaced by `checkDeployRuntime()`), warn once per process, and keep
  > working over the introspected app. No codemod: the replacement returns the
  > verdicts the two calls produced together.

## Decisions

The open questions were closed on acceptance:

1. **Workers-only providers that touch bindings at `register()`.** Part 1 adds
   `ServiceProvider.introspect?()` to `@guren/plugin-cloudflare`'s own provider
   and ships no stub built from the wrangler config. A provider that throws is
   recorded as `register: 'threw'`, and readers treat what it would have bound
   as unverified.
2. **Side effects at import.** The reader maps the `listen()` throw to
   `crashed`, and the message points at the `bin/serve.ts` shape: `src/main.ts`
   exports the app, and `bootstrapApplication()` boots it and calls `listen()`.
   It is never reported silently.
3. **`options.boot` callback.** Not run. When present, the manifest carries a
   `boot-callback-skipped` warning.
4. **`getCookielessAuthPaths()`.** The order stays as it is.
   `csrf-exemption-audit.ts` keeps its `node_modules` scan, in Part 2 as well.
5. **Schema JSON.** The manifest carries JSON Schema from the zod-compat walker
   `@guren/openapi` uses, never the live Zod object. A reader that needs key
   names (`route-contract-check`) reads them from `properties` in Part 2.
