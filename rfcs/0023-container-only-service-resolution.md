# RFC: Container-Only Service Resolution

**Author:** 7nohe
**Date:** 2026-09-11
**Status:** Accepted (2026-09-12 — the standard two-week discussion window
was shortened by the deciding maintainer for this solo-driven change)

## Problem

Every `Application` owns a DI container: the constructor creates one
(`packages/server/src/http/Application.ts:506`), binds `app`, `hono`, `auth`
and `router` into it (`:517-520`), and hands it to the router at mount time
(`:658`, `RouterMountOptions.container`, `mvc/Router.ts:336`). Providers bind
their managers under the keys `ServiceBindings` names
(`container/bindings.ts:25-57`). Then the constructor's last statement
publishes that container into a module-level slot (`setContainer`, `:585`),
and beside it thirteen more module-level slots hold the services the
container already binds. The consumers read the slots.

What exists today (verified at `30a26e94`):

| Slot | Declared at | Setter / getter | Who sets it | Who reads it | Container key |
|---|---|---|---|---|---|
| `globalContainer` | `container/Container.ts:336` | `setContainer` `:338` / `getContainer` `:342` | `Application` constructor `:585` | `Job.make()` (`queue/Job.ts:45`), `resolve()` (`Container.ts:349`), scaffold `config/attachments.ts` (`getContainer().make('storage')`) | (is the container) |
| `globalGate` | `authorization/Gate.ts:334` | `setGate` `:340` / `getGate` `:344` | `AuthorizationServiceProvider.ts:11` | `Controller.authorize/can` (`mvc/Controller.ts:215,220`), `authorization/middleware.ts:24,71,134`, `defineGate`/`can`/`cannot`/`authorize` (`Gate.ts:353-365`), blog template `AuthorizationProvider.boot()` | `gate` (`AuthorizationServiceProvider.ts:12`); no reader in `packages/*/src` |
| `globalEncrypter` | `encryption/Encrypter.ts:207` | `setEncrypter` `:213` / `getEncrypter` `:217` | nobody in `packages/` | `encrypt()` `:225`, `decrypt()` `:230` | `encrypter` (`EncryptionServiceProvider.ts:12`) |
| `globalMailManager` | `mail/Mail.ts:211` | `setMailManager` `:214` / `getMailManager` `:218` | scaffold `MailProvider.boot()` (`cli/templates/scaffold/mail/.../MailProvider.ts:21`), `examples/blog` `EventServiceProvider.ts:52` | `SendMailJob.handle()` `:229` | `mail` (`MailServiceProvider.ts:7`) |
| `globalDriver` (queue) | `queue/Job.ts:6` | `setQueueDriver` `:8` / `getQueueDriver` `:12` | `QueueManager.driver()` on the *first* resolution of the default driver only (`queue/QueueManager.ts:48-50`), `setDefaultDriver()` `:84`, `@guren/core` attachments engine on every queued attach (`core/src/attachments/engine.ts:871`) | `Job.dispatch()` `:58`, `Mail.queue()` `:187`, `guren queue:work` (`cli/src/queue.ts:172`), attachments engine `:874` | `queue` (`QueueServiceProvider.ts:7`); nothing in `packages/*/src` calls `make('queue')` |
| `globalI18n` | `i18n/I18nManager.ts:143` | `setI18n` `:151` / `getI18n` `:156` / `tryGetI18n` `:164` | nobody in `packages/` | `t()`/`tc()` `:169-175`, `Controller.#resolveI18n` after the container (`Controller.ts:334-340`), `detectLocaleMiddleware` default (`http/middleware/detect-locale.ts:145`) | `i18n` (`I18nServiceProvider.ts:40`) |
| `globalLogManager` | `logging/LogManager.ts:192` | `setLogManager` `:194` / `getLogManager` `:198` | nobody in `packages/` | nobody in `packages/*/src` | `log` (`LogServiceProvider.ts:7`) |
| `globalNotificationManager` | `notifications/NotificationManager.ts:322` | `setNotificationManager` `:324` / `getNotificationManager` `:328` | nobody in `packages/` | nobody in `packages/*/src` | `notifications` (`NotificationServiceProvider.ts:7`) |
| `SendNotificationJob.notificationManager` (static) | `NotificationManager.ts:253` | `registerQueueJob()` `:223` | `NotificationServiceProvider.boot()` `:13-15` | `SendNotificationJob.handle()` `:256` | same |
| `globalBroadcastManager` | `broadcasting/BroadcastManager.ts:521` | `setBroadcastManager` `:523` / `getBroadcastManager` `:527` | nobody in `packages/` | nobody in `packages/*/src` | `broadcast` (`BroadcastServiceProvider.ts:7`) |
| `globalExceptionHandler` | `errors/ExceptionHandler.ts:195` | `setExceptionHandler` `:197` / `getExceptionHandler` `:201` | nobody in `packages/` | nobody in `packages/*/src` (`ErrorServiceProvider.boot()` wires `hono.onError` from the binding, `:13-15`) | `exception.handler` |
| `documentOptions`, `defaultSsrRenderer` | `mvc/inertia/InertiaEngine.ts:96,111` | `setInertiaDocument` `:105` / `setInertiaSsrRenderer` `:119` (no getters) | templates' `src/app.ts` at module scope, `web/src/app.ts:23`, the Workers entry `plugin-cloudflare` generates (`build.ts:1130`) | the engine, `:478` and `:335` | none |
| `globalRegistry` (shared props) | `mvc/inertia/shared.ts:115` | `setInertiaSharedProps` `:140` / `getInertiaSharedPropsResolver` `:151` | `examples/blog/config/inertia.ts:15` | `resolveSharedInertiaProps` | `inertia.sharedProps`, container-scoped registry with the global as fallback (`:111-134`) |
| `defaultStore` (rate limit) | `http/middleware/rate-limit.ts:232` | `getDefaultStore()` `:234`, no setter | lazily, first middleware without `store` | `createRateLimitMiddleware` `:257` | none |
| `defaultCandidates`, `manifestCache` | `http/vite-assets.ts:29-30` | `__resetViteAssetCache` `:33` | first render | manifest resolution | none |
| `activeEngine` (attachments, `@guren/core`) | `core/src/attachments/engine.ts:1358` | `setActiveAttachmentEngine` `:1361` / `getActiveAttachmentEngine` `:1370` | `configureAttachments()` | the delivery route | none |

The `global*` variables are module-private; only the `set*`/`get*` pairs and
the functional helpers built on them are public, all through
`packages/server/src/index.ts` (`:181-182`, `:525-526`, `:558-559`,
`:646-647`, `:674-678`, `:778-779`, `:811-812`, `:842-844`, `:872-874`,
`:919-924`, `:960-963`) and from there `@guren/core` (`core/src/index.ts:1`).

Five of the slots (log, notifications, broadcast, exception handler, and the
`gate` *binding*) have a setter or a getter nobody in the framework calls.
The rest are load-bearing, and that is where the defects live.

### What it costs today

- **Two `Application`s in one process are last-writer-wins.**
  `TestApp.create()` constructs `new Application(...)` and boots it
  (`packages/testing/src/test-app.ts:427-437`). Boot runs
  `AuthorizationServiceProvider.register()`, which is `setGate()`. Two
  `TestApp`s alive in one `bun test` process share one `globalGate`: the
  policies the first app registered are consulted by nobody once the second
  boots, because `Controller.authorize()` reads `getGate()` (`Controller.ts:215`),
  not the `gate` its own container binds, and not `this.make('gate')`, a
  helper the same class already has (`Controller.ts:189-195`).
  `registerQueueJob()` does the same to the notification job's static field,
  and `Application.ts:585` to the container itself.
- **The same service has two resolution paths, so a half-configured state is
  the normal state.** `EncryptionServiceProvider` binds `encrypter` and never
  calls `setEncrypter()`, so `encrypt()`/`decrypt()` throw
  `Encrypter not initialized` in every app that did not wire the global by
  hand. `I18nServiceProvider` binds `i18n` and passes the manager to
  `detectLocaleMiddleware` explicitly (`:60`) without calling `setI18n()`, so
  `t()` throws in a `createApp({ i18n })` app while `this.t()` in a controller
  works (container first, `Controller.ts:335`). `QueueServiceProvider` binds a
  manager; `Job.dispatch()` reads a driver that only exists once *something*
  resolved the default driver, which is why the attachments engine reasserts
  the global on every dispatch (`engine.ts:867-871`) and why the scaffold's
  `MailProvider` needs a `boot()` whose only job is `setMailManager()`.
- **Tests need reset seams.** `clearJobRegistry`, `clearNotificationRegistry`,
  `resetWarnOnce`, `__resetViteAssetCache` and the documented
  `setInertiaSsrRenderer(undefined)` ("test isolation", `InertiaEngine.ts:117`)
  exist because state outlives its app. Across `packages/*/{src,tests}`,
  `setQueueDriver(` appears 16 times and `clearJobRegistry(` 14.
- **Workers and Lambda are fine per isolate, and the design still cannot
  express a request scope.** `Container.scoped()`/`scopedAsync()`
  (`Container.ts:225,235`) push a `Map` onto `scopedInstances` (`:20`), a
  stack; two overlapping async requests would interleave pushes and pops.
  Their only callers are `packages/server/tests/container/container.test.ts`.
  Everything request-scoped today rides the Hono context instead
  (`AUTH_CONTEXT_KEY`, `http/middleware/auth.ts:67`; `LOCALE_CONTEXT_KEY`,
  `detect-locale.ts:143`; the agent principal, keyed on the `Request` object,
  `internal/agent-principal.ts:1-8`).

### What already points the right way

Cache, events, storage, scheduler, health, OAuth and sessions (RFC 0020) have
no global slot at all: they are container-only and no harder to use.
`Command` receives its container in the constructor (`console/Command.ts:21-23`)
and the scaffolded `src/console.ts` passes `app.container`. Shared Inertia
props keep a container-scoped registry with the global as a fallback for
bare-Hono apps (`shared.ts:111-134`). `Controller.#resolveI18n` reads the
container before the global (`Controller.ts:334-340`). `createFacade(container,
key)` re-resolves on every access (`facades/index.ts:8-21`); five guides
document `createFacades(app.container)` and nothing under `packages/`,
`examples/` or `web/src` calls it. This RFC applies the established pattern
to the rest.

## Proposed Solution

One rule: a service is resolved from the container of the `Application` that
owns the request, the job, or the command. No consumer inside `packages/`
reads a module-level slot. The public `set*`/`get*` functions and the
functional helpers built on them stay for the deprecation window as shims
over the *default application's* container, then go at the next major.

### 1. Keys

`ServiceBindings` (`container/bindings.ts`) already names every service in
the table: `gate`, `encrypter`, `mail`, `queue`, `log`, `i18n`,
`notifications`, `broadcast`, `exception.handler`, `inertia.sharedProps`.
Three keys are added, all bound by `Application` from `createApp()` options:

```ts
// packages/server/src/container/bindings.ts
export interface ServiceBindings {
  // ...existing keys unchanged
  /** `createApp({ inertia: { document } })`; read by InertiaEngine instead of the module slot. */
  'inertia.document': InertiaDocumentOptions
  /** `createApp({ inertia: { ssrRenderer } })`; per-call `ssr.render` still wins. */
  'inertia.ssrRenderer': InertiaSsrRenderer
  /** Bound by `configureAttachments()` on the app it is given (see §4). */
  attachments: AttachmentEngine
}
```

**Amended in implementation:** ~~`attachments` is declared in server's
`bindings.ts`~~ — the engine type lives in `@guren/core`, which server cannot
import, so core declares the key by augmenting `ServiceBindings` from
`attachments/engine.ts`, the same way it adds the `database` session driver to
`SessionDrivers`. A test pins the augmentation surviving into core's bundled
`.d.ts`.

The rate-limit default store becomes one `MemoryRateLimitStore` per
middleware instance (constructed inside `createRateLimitMiddleware`), which is
what the `store` option already does; a process-wide bucket shared by every
limiter that omitted `store` was never intended. `vite-assets` memoizes
filesystem reads, not a service, and stays as is.

### 2. How a consumer gets its container

| Consumer | Today | After |
|---|---|---|
| Controller | `_container` set by `Router.ts:1410`; `authorize()` ignores it | `authorize()`/`can()` use `this.make('gate')`; `this.t()` drops the `tryGetI18n()` fallback |
| Middleware (`can()`, `authorize()` in `authorization/middleware.ts`, `detectLocaleMiddleware`, rate limit) | `getGate()`, `tryGetI18n()` | `getRequestContainer(ctx)` (below) |
| Job | `new JobClass()` in `Worker.ts:115`; `Job.make()` reads `getContainer()` | `Worker` takes `{ container }`, calls `instance.setContainer()` before `handle()`; `Job.make()` reads it |
| Console command | `this.container` (`Command.ts:21`) | unchanged |
| Provider | `this.container` | unchanged; providers stop calling `set*()` |
| Module-scope and provider-`boot()` helpers (`encrypt()`, `t()`, `can()`, `defineGate()`, `Job.dispatch()`, `resolve()`) | the module slot | the default application's container (§3) |

The request accessor:

```ts
// packages/server/src/http/request-container.ts
export const CONTAINER_CONTEXT_KEY = 'guren.container'

declare module 'hono' {
  interface ContextVariableMap {
    [CONTAINER_CONTEXT_KEY]: Container
  }
}

/** The container of the Application serving `ctx`; throws off an Application (bare Hono). */
export function getRequestContainer(ctx: { get: (key: string) => unknown }): Container
export function tryGetRequestContainer(ctx: { get: (key: string) => unknown }): Container | undefined
```

`Application.mountSecurityDefaults()` (`Application.ts:763`) already installs
the one middleware an app cannot get in front of; `ctx.set(CONTAINER_CONTEXT_KEY,
this.container)` goes first in that chain. Same shape as the auth context
and the locale: the context is the request scope Guren already has.

### 3. Functional helpers resolve the default application, not `AsyncLocalStorage`

`encrypt()`, `t()`, `can()`, `defineGate()`, `Job.dispatch()` and `resolve()`
have no handle to pass. Two designs were weighed: `AsyncLocalStorage`
(`app.fetch()` runs the request inside `store.run(container, ...)`, helpers
read `store.getStore()`), or a default application (the container the
constructor publishes today, `Application.ts:585`, given a name and a
contract). The default application is chosen:

1. The helpers are called where no request is running. `setInertiaDocument`
   runs at module scope in every template; `defineGate()` runs in a
   provider's `boot()` (`examples/agents/app/Providers/AuthProvider.ts:38`);
   `guren queue:work` dispatches with no HTTP context at all. An async store
   has nothing to return there, so the fallback to a default application is
   needed anyway, and then it is the mechanism.
2. The repo already avoids the dependency where it can. The agent principal
   seam keys on the `Request` object precisely so it "needs no
   `AsyncLocalStorage` (identical on workerd and Bun)"
   (`internal/agent-principal.ts:6`); the ORM imports `node:async_hooks` on
   demand so it "stays off the module graph of a Workers or Lambda bundle"
   (`orm/src/adapters/drizzle-adapter.ts:233`). Workers need `nodejs_compat`
   for it (`plugin-cloudflare/src/build.ts:1345` sets it; a user-written
   `wrangler.jsonc` may not).
3. Anything inside a request has a better handle, the context (§2); the
   ambient path is for the residue, and a plain default covers it.

Contract:

```ts
// packages/server/src/http/default-application.ts
/** The most recently constructed Application, as today; `null` before any exists. */
export function defaultApplication(): Application | null
/** Opt-in override for a process that constructs several and wants the ambient one chosen, not last. */
export function useAsDefaultApplication(app: Application): void
/** @internal test seam; replaces every `set*(undefined)` and `clear*()` reset. */
export function resetDefaultApplication(): void
/** The default application's container; throws the same "not initialized" error the getters throw today. */
export function defaultContainer(): Container
```

Last-constructed stays the rule because that is what a sequential
`bun test` process needs: each file's `TestApp` is the live one. The hazard
is two *live* apps plus an ambient call, so constructing a second
`Application` while a first exists sets a flag, and the first ambient call
after that warns once (`warnOnce('ambient-application-ambiguous', ...)`),
naming `useAsDefaultApplication()` and the explicit forms.

The explicit forms are what exists: `container.make(key)`, `this.make(key)`
in controllers, jobs and commands, `createFacades(container)`. `t()` keeps
its signature; a request-aware translation already exists as
`getRequestTranslator(ctx)` (`detect-locale.ts:20`). `Job.dispatch()` gains
its explicit twin on the manager, which is where the driver lives:

```ts
// packages/server/src/queue/QueueManager.ts
class QueueManager {
  /** Explicit form of `JobClass.dispatch(payload, options)`. */
  dispatch<T>(JobClass: JobClass<T>, payload: T, options?: JobOptions): Promise<string>
}
// Job.dispatch(payload, options) === defaultContainer().make('queue').dispatch(this, payload, options)
```

`QueueManager.driver()` stops publishing a global (`QueueManager.ts:48-50`,
`:84`); `guren queue:work` resolves `container.make('queue').driver()` from the
app it boots (`cli/src/queue.ts:155-176`) and passes that container to the
`Worker`.

### 4. Providers own the binding; nothing else writes

- `AuthorizationServiceProvider.register()` binds `gate` and drops `setGate()`.
- `SendMailJob.handle()` uses `this.make('mail')`; the scaffold `MailProvider`
  loses its `boot()`; `Mail.queue()` resolves `queue` through the manager it
  was built from (`Mail.ts:244`), so `MailManager` gains the container it is
  bound with.
- `SendNotificationJob` uses `this.make('notifications')`; the static field
  and `registerQueueJob()`'s assignment go.
- `encrypt()`/`decrypt()` read `defaultContainer().make('encrypter')`. This
  is the one change that turns a throw into a working call for every
  scaffolded app.
- `t()`/`tc()` read `defaultContainer().make('i18n')`; `detectLocaleMiddleware`
  defaults `i18n` to `tryGetRequestContainer(c)?.makeOptional('i18n')`.
- `InertiaEngine` reads `inertia.document` and `inertia.ssrRenderer` from
  ~~`getRequestContainer(ctx)`~~ **Amended in implementation:** the engine
  never sees a context (`inertia(component, props, options)` takes the raw
  `Request`), so it reads them from `InertiaOptions.container`, which
  `Controller.inertia()` fills with its own container. Shipped in Part 0, so
  the `createApp({ inertia })` option it introduces is not inert;
  `setInertiaDocument()`/`setInertiaSsrRenderer()`
  become shims that bind on the default application. The Workers entry
  `plugin-cloudflare` generates ~~switches to the option in the same PR~~ stays
  on the setter until Open Question 4 is decided; the setter remains the
  fallback the engine reads second.
- `configureAttachments({ app })` binds `attachments` on that app; the
  delivery route resolves it from the request container. The scaffold's
  `storage: () => getContainer().make('storage')` becomes
  `storage: (container) => container.make('storage')`: the factory receives
  the container it is bound on.
- `Container.scoped()`/`scopedAsync()` are left alone in Part 1 (Open
  Question 2).

### 5. The shims

Every exported setter and getter keeps its signature and forwards:

```ts
// packages/server/src/authorization/Gate.ts (pattern for all nine pairs)
/** @deprecated since 2.23.0, removed in 3.0.0. Bind `gate` on the app's container; providers already do. */
export function setGate(gate: Gate): void {
  warnDeprecated('global-service-setters', 'setGate')
  defaultContainer().instance('gate', gate)
}
/** @deprecated since 2.23.0, removed in 3.0.0. Use `this.make('gate')`, `getRequestContainer(ctx)`, or `defaultContainer()`. */
export function getGate(): Gate {
  warnDeprecated('global-service-getters', 'getGate')
  return defaultContainer().make('gate')
}
```

`warnDeprecated(id, symbol)` is `warnOnce` keyed per symbol in the policy's
message format (`Seeder.ts:27-33` is the existing shape). The module-private
`let global*` declarations go in Part 2; only the exported functions are
under the policy's window.

| Deprecation id | Symbols | Replacement |
|---|---|---|
| `global-service-setters` | `setGate`, `setEncrypter`, `setMailManager`, `setQueueDriver`, `setI18n`, `setLogManager`, `setNotificationManager`, `setBroadcastManager`, `setExceptionHandler`, `setContainer`, `setInertiaDocument`, `setInertiaSsrRenderer`, `setInertiaSharedProps` | `container.instance(key, value)` in a provider; `createApp({ inertia })` for the two Inertia options; `shareInertiaProps(fn, container)` |
| `global-service-getters` | `getGate`, `getEncrypter`, `getMailManager`, `getQueueDriver`, `getI18n`, `tryGetI18n`, `getLogManager`, `getNotificationManager`, `getBroadcastManager`, `getExceptionHandler`, `getContainer`, `getInertiaSharedPropsResolver` | `this.make(key)`, `getRequestContainer(ctx).make(key)`, `defaultContainer().make(key)` |
| `attachments-active-engine` (`@guren/core`) | `setActiveAttachmentEngine`, `getActiveAttachmentEngine` | `configureAttachments({ app })`, `container.make('attachments')` |

Not deprecated: `encrypt`, `decrypt`, `t`, `tc`, `can`, `cannot`,
`defineGate`, `authorizeAbility`, `resolve`, `Job.dispatch`, `Job.make`. Same
signatures, resolving from the default container (`resolve(key)` becomes
`defaultContainer().make(key)` outright).

### Implementation plan

Referencing `RFC 0023` in each PR:

0. **Seams, no behaviour change** (`@guren/server`, minor): `getRequestContainer`
   and the context stamp; `Worker` `{ container }` option and
   `Job.setContainer()`; `QueueManager.dispatch()`; `defaultApplication()`
   family over the slot `Application.ts:585` already writes; the three
   bindings and `createApp({ inertia })`. Additive.
1. **Consumers read the container, global as fallback** (server + core + cli
   scaffolds, minor): every row of §4, each reading its container first and
   the old slot second, so an app that still calls `setX()` by hand keeps
   working. Providers stop calling setters. The scaffold `MailProvider` and
   `config/attachments.ts` change; `guren queue:work` resolves through the
   container. Test: two `Application`s booted in one process, each with a
   different policy for the same model, each authorizes by its own. Core
   gets a changeset (the allowlist rule in `.claude/rules/common-pitfalls.md`).
2. **Deprecate** (server + cli, minor, target `2.23.0`): stages 1 to 5 of
   `contributing/deprecation-policy.md`. JSDoc `@deprecated` on the 25
   symbols; `warnDeprecated` on first call; the three
   `packages/cli/src/deprecations.ts` entries above, `detect()` scanning
   import specifiers from `@guren/core` and `@guren/server`; CHANGELOG
   `### Deprecated`; the codemod (Migration Path). Part 1's fallback reads
   go here: the shims now write to the container, so no slot is left to read.
3. **Remove** (server `3.0.0` and core `2.0.0`, same release): delete the
   shims, `let global*`, `SendNotificationJob.notificationManager`, and the
   `clear*`/`reset*` seams that existed only for them. Core majors with
   server because `core/src/index.ts:1` re-exports every removed symbol;
   `audit:core-semver` fails a plan that majors `@guren/server` alone
   (`.claude/rules/common-pitfalls.md`: "The version core sits on is
   independent; the bump type is not"). Two minors at least separate Part 2
   from Part 3 (stable-API rule).

## Alternatives Considered

- **Keep the singletons and delete the container bindings.** Honest about
  what runs today, and five bindings would go unnoticed. It forecloses a
  second `Application` per process (the testing package's model) and any
  request scope, and contradicts `Command`, `Controller.make()`,
  `createFacades()` and five guides, all of which hand out a container.
- **Facades as the resolution rule.** `createFacades()` exists
  (`facades/index.ts:74-87`) with no caller outside docs. A facade is a
  consumer style over a container, not a way to find one; it needs the
  container this RFC supplies, and it stays as the explicit form.
- **`AsyncLocalStorage` as the only ambient.** Rejected as the sole
  mechanism in §3: module-scope and `boot()` callers have no async context,
  and the repo has twice chosen not to depend on it for the serverless
  bundles. It remains the candidate for a real request scope (Open Question 1).
- **A container parameter on every functional helper.**
  `t(key, replacements, container)` in a template, `encrypt(value, options,
  container)` in a model hook: a second explicit form beside
  `container.make(key)` and the facades.
- **Keep the setters, make them per-app (a `WeakMap<Application, Gate>`).**
  Still a slot a provider must remember to write, still two paths. And the
  symbols are documented (`getGate` in four guides, `getContainer` in three,
  `setInertiaDocument` in four), so the deprecation policy applies either way.

## Migration Path

Per `contributing/deprecation-policy.md`, Part 2 registers the three
deprecations (`bunx guren upgrade --check-only` lists affected files) and
`bunx guren upgrade` applies the codemod below. What an app changes:

| App code today | After | Codemod |
|---|---|---|
| `getGate().policy(Post, PostPolicy)` in a provider `boot()` (blog template) | `this.container.make('gate').policy(Post, PostPolicy)` | Yes: inside a class extending `ServiceProvider`, `getGate()` → `this.container.make('gate')`; same for the other getters by key |
| `setMailManager(manager)` in a provider that also binds `mail` (scaffold) | delete the call | Yes, when the same class binds the key; otherwise reported |
| `setMailManager(m)` in a provider that binds nothing (`examples/blog`) | `this.container.instance('mail', m)` | Yes |
| `setInertiaDocument({...})` at module scope with an inline literal | `createApp({ inertia: { document: {...} } })` | Yes, when `createApp(` is in the same file; otherwise reported |
| `getContainer().make('storage')` in `config/attachments.ts` | `(container) => container.make('storage')` | Yes, inside a `configureAttachments()` factory; elsewhere reported |
| A custom `Job` reading `getContainer()` in `handle()` | `this.make(key)` | Yes, inside a class extending `Job` |
| Tests calling `setGate`/`setQueueDriver` to inject a fake | `app.container.instance('gate', fake)` or `container.fake(key, fake)` | Reported only |

The codemod is idempotent, AST-based (`@babel/parser`, as `deprecations.ts`
already uses) and tested against `examples/blog`. Timeline: deprecated in the
Part 2 minor, removed at server `3.0.0` / core `2.0.0`, two minors later at
the earliest.

## Open Questions

1. **Request scope semantics.** With the container on the context, the next
   step is a per-request child container (`container.createChild()` under
   `CONTAINER_CONTEXT_KEY`) so a request translator or the auth context can
   be bindings rather than context keys. Leaning: this RFC defines only the
   stamp; the scope is its own RFC once one service needs it.
   **Decision:** this RFC defines only the stamp. A per-request child
   container is its own RFC, once one service needs it.
2. **`Container.scoped()` / `scopedAsync()`.** Stack-based, unsafe under
   concurrent requests, zero callers outside their test. Remove in Part 3, or
   reimplement over question 1's child container? Leaning: remove.
   **Decision:** remove in Part 3.
3. **Default application: last-constructed or first?** Last matches
   sequential tests and today's `:585`; first would protect a long-lived
   server from a stray `new Application()` in a plugin. Is the warn-once on
   a second construction enough?
   **Decision:** last-constructed wins, as today. Constructing a second
   `Application` while one exists marks the ambient choice ambiguous, and
   the first ambient call after that warns once, naming
   `useAsDefaultApplication()`.
4. **`inertia.document` as a `createApp()` option versus a provider
   binding.** The option reads well in a scaffold; the generated Workers entry
   (`build.ts:1130`) calls the setter after importing the app, which the
   option cannot express. Keep both, or have the plugin bind directly?
5. **The class registries.** `jobRegistry` (`Job.ts:129`) and
   `notificationRegistry` (`notifications/registry.ts:13`) map wire names to
   classes and are per process by design. Out of scope unless two apps in one
   process need conflicting `jobName`s.
6. **`getContainer()` after removal.** `defaultContainer()` is the successor.
   Keep `getContainer` as an alias for the three guides and the attachments
   scaffold, or remove it? Leaning: remove; the codemod covers the scaffold.
   **Decision:** remove in Part 3; `defaultContainer()` succeeds it and
   the codemod covers the scaffold.
