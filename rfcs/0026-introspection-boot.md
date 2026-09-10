# RFC: Introspection Boot

**Author:** 7nohe
**Date:** 2026-09-11
**Status:** Draft

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
export function isIntrospecting(): boolean   // process.env.GUREN_INTROSPECT === '1'
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
  stores: Record<string, { driver: string; table?: string; perProcess: boolean }>
}

export interface AuthEntry {
  guards: string[]; defaultGuard: string | null
  providers: Record<string, { kind: string; model?: string; hasher: string }>   // hasher: constructor.name
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
`describeActiveAttachmentEngine()` in `@guren/core`. `perProcess` comes from the
same `PER_PROCESS_SESSION_DRIVERS` set the runtime warning uses.

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

### 5. Who reads the manifest, who stays static

| Module | Today | After Part 2 | Part 3 |
|---|---|---|---|
| `deploy-runtime.ts` | AST scan (`:156-467`) feeding `judgePasswordHashing`, `judgeRuntimeStores`, `judgeProviderDiscovery` (`:661-822`) | `DeployRuntimeAnalysis` built from `auth.providers[*].hasher`, `session`, `cache`, `queue`, `providers[*].source` | Extractor deleted; `checkDeployRuntime(cwd)` keeps its signature, so `@guren/core/internal/deploy-check` (`deploy-check.ts:33-58`) is untouched |
| `session-config.ts`, `sessions-check.ts` | AST for `SessionConfig`, regex for the binding provider | `session.source === 'none'` while a `SessionConfig` file exists is the inert-config finding; `stores[*].table` against the schema export list (the schema half stays AST, §5 last row) | `session-config.ts` reduced to the schema-binding lookup |
| `attachments-check.ts` | AST over `configureAttachments()` arguments, route lookup | `attachments.{table,disk,delivery}`; `delivery.mounted` from the routes | Argument parsing deleted; `Attachable(...)` model detection stays AST (a model file is not executed by registration) |
| `controller-methods.ts` | key `ClassName.method`, collisions | key `file#export.method` from `ControllerRef`; the body scan itself stays | `ControllerNameCollision` reported only for `name-only` refs |
| `audit.ts` auth/validation | middleware names + body regex | resolved `middleware[]` with capabilities and `ability`; contract `schemas.body` presence; body regex only for the in-action `userOrFail()` / `validateBody()` case | unchanged scope |
| `audit.ts` raw SQL, secrets, mass assignment, CSRF exemptions | source and `node_modules` scans (`:656-660`, `csrf-exemption-audit.ts`) | unchanged: body-level and dependency-level facts | unchanged |
| `route-contract-check`, `agent-route-check`, `agents-types`, `routes-types`, `prototype-check` | `loadRouteDefinitions()` | the manifest's `routes` (a `RouteDefinition` superset) plus `module` provenance; no rule changes | `load-routes.ts` becomes the static fallback only |
| `doctor.ts` deploy section, `context.ts`, `spec-generate.ts` | `analyzeDeployRuntime`, `loadContextRoutes` | manifest | |
| `docs-check`, `docs-index`, `i18n-check`, `spec-check`, `arch-check`, `audit:prose` | static | static by nature: prose, links, import graphs | |
| `schema-parser`, `schema-check`, `schema-binding` | Drizzle AST | static: the database is never opened, and `db/schema.ts` is data, not behaviour | |
| all `make:*` / `add` scaffolders, `route-registrar` patching, `inflect`, `drizzle-pins` | static | static: they write source, and must run on an app that does not compile yet | |

Fallback rule for Part 2: when `introspectApp()` returns `failed`, every check in
the first five rows runs its current static path and marks the result
`evidence: 'static'`; a check that has no static path reports
`status: 'warn'` with `unverified` in the key; a section behind a provider whose
`register` is `'threw'` is treated the same way. No verdict is ever `pass` on
absent evidence: `CheckResult` gains `evidence: 'manifest' | 'static' | 'none'`.

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
2. **Consumers** (§5 rows 1-8) with the static fallback and `evidence`. Verdicts
   may change for an app where the source scan guessed wrong; each such change is
   a changeset entry naming the check key.
3. **Retire** the source scans the table marks. `tests/deploy-runtime.test.ts`
   shrinks to the judge functions over manifest fixtures; the CLAUDE.md rows for
   `deploy-runtime`, `session-config` and the collision half of
   `controller-methods` are rewritten to point at the manifest.

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
- `loadRouteDefinitions()` is not deprecated: it is the static fallback and the
  path for a scaffold mid-generation whose `src/app.ts` does not import yet.
- No deprecation is introduced, so `deprecations.ts` and `codemods.ts` are
  untouched. Changesets: `@guren/server` minor, `@guren/core` minor,
  `@guren/cli` minor for Part 1; `@guren/cli` minor for Parts 0, 2, 3.

## Open Questions

1. **Workers-only providers that touch bindings at `register()`.**
   `getWorkersEnv()` throws before the first request captures `env`
   (`packages/plugin-cloudflare/src/env.ts:27-34`), and `bootWorkersApp()` runs
   `boot()` only after `captureWorkersEnv(env)` (`boot.ts:46-58`). A provider
   that reads `env.DB` in `register()` therefore throws under introspection and
   lands as `register: 'threw'`. Is a `ServiceProvider.introspect?` on the
   plugin's own providers enough, or should `@guren/plugin-cloudflare` ship a
   `captureWorkersEnv(stubFromWranglerConfig())` for the introspection child,
   reading `wrangler.jsonc` the way `build.ts:521-532` already does?
2. **Side effects at import.** `modules/*/index.ts` is imported today
   (`load-routes.ts:109`); `src/app.ts` is the new exposure. Should `guren
   introspect` refuse an entry whose module scope calls `listen()` (detected by
   the throw) with a pointer to the `bin/serve.ts` shape, or report silently?
3. **`options.boot` callback.** Skipped in §1 because it is arbitrary code over
   Hono. An app that registers routes inside it (the pre-registrar shape) then
   shows fewer routes under introspection than at runtime. Report a warning when
   the callback is present, or run it and accept the exposure?
4. **`getCookielessAuthPaths()`.** Declared in `boot()` after `mountRoutes()`
   (`Application.ts:617-618`), so a register-stage manifest cannot list them
   and `csrf-exemption-audit.ts` keeps its `node_modules` scan. Is a
   `declareCookielessAuthPath()` moved to `register()` worth the ordering
   change it would need?
5. **Schema JSON.** `RouteEntry.schemas` is JSON Schema through the `zod-compat`
   walker `@guren/openapi` uses. Should `route-contract-check` keep the live Zod
   object instead, at the price of never running from a manifest file?
