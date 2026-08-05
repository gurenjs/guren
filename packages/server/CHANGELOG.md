# @guren/server

## 2.1.1

### Patch Changes

- 87bbd81: Reject path-traversal names in the `make:*` scaffolders

  `make:test` and `make:view` accept a nested name (`make:view posts/Index`,
  `make:test auth/Login`) and interpolated its segments straight into the output
  path. `trimSlashes()` only strips the edges and `split('/').filter(Boolean)`
  keeps `..` — it is non-empty — so a name like `../../../../tmp/evil` wrote
  outside the project, and `--force` overwrote whatever was already there. The
  name is not always something you typed: the MCP tool `guren_make_component`
  declares it as an unvalidated request field, so an agent working from untrusted
  content could reach it.

  Nested names are now split with traversal rejected rather than stripped, and
  every `make:*` scaffolder writes through a writer that asserts the resolved path
  stays under the project root. `scaffoldFile()` (behind `make:controller`,
  `make:model`, `make:route`, …) and the batch writer behind `make:feature`,
  `make:auth`, and `make:module` had no containment check at all before this and
  were safe only because `pascalCase()` happens to strip separators — the same
  incidental safety `make:route` did not have.

  Only traversal is rejected, so names the filesystem accepts still work:
  `guren make:test "admin/my page"` and `guren make:view "顧客/Index"` behave
  exactly as before. Codegen (`guren codegen --out`) is deliberately exempt, since
  its output directory is yours to choose and may sit outside the project.

  `secureCompare()` from `@guren/server/auth` is hardened in the same release.
  `Buffer.from(value, 'hex')` stops decoding at the first invalid pair, so two
  different strings that share an invalid prefix — `'zzzz'` and `'yyyy'`, or
  `'abcz'` and `'abdz'` — decoded to identical buffers and compared **equal**. It
  now rejects input whose hex decode does not round-trip to the original length.
  If you called it with UUIDs, base64 tokens, or anything else that is not strict
  hex, switch to `secureStringCompare()`, which is built for exactly that.

## 2.1.0

### Minor Changes

- ee6f1bd: Accept middleware handler functions in `Router.middleware()` and
  `RouteBuilder.middleware()`, alongside the registered alias names they already
  took. Four guides across both doc languages — rate limiting, middleware, API
  tokens, email verification — documented `router.post(path, action).middleware(
createRateLimitMiddleware())` and `router.middleware(handler).group(...)`, and
  every one of those snippets failed to compile with `Argument of type
'MiddlewareHandler' is not assignable to parameter of type 'never'`.

  Both call sites now take alias names, handlers, or a mix. They resolve by kind
  rather than by position: every name in a route's chain runs before every
  handler, across groups as well as within one call — so an inline handler on an
  outer group runs after a named one on an inner group. Use aliases throughout
  when relative order matters. Aliases are also the only form `guren audit` can
  report by name; the guards it recognizes (`requireAuthenticated`,
  `requireGuest`) are detected either way.

  `Router.group()` and `middleware(...).group()` now throw when handed an `async`
  callback, and `Router.group()` unwinds its prefix if the callback throws. Group
  scopes are popped synchronously, so a callback that awaited before registering
  its routes silently lost the prefix or middleware the group was opened with —
  including auth guards. This was already the behavior for alias names; the fix
  covers both.

  `requireVerifiedEmail`'s `getUser` option typed its argument as `unknown`, so a
  callback could not read the context at all. It now receives `{ get<T>(key) }` —
  Hono's context idiom — with the type argument inferred from the expected
  return, so the documented `getUser: async (ctx) => ctx.get('user')` compiles
  without a cast. Callbacks written against the old `unknown` signature remain
  assignable.

### Patch Changes

- 6feada3: Build emailed auth links from `APP_URL` instead of the request host

  The password reset flow scaffolded by `guren add auth` (and by
  `create-guren-app --auth`) built its link from the request:

  ```js
  buildPasswordResetUrl(
    `${new URL(this.request.url).origin}/reset-password`,
    token,
    email
  );
  ```

  A server request's URL is reconstructed from the `Host` header, which any
  client can forge — the framework's own host-authorization middleware says so,
  reading `ctx.req.header('host') ?? new URL(ctx.req.url).host` as one value. So
  an unauthenticated attacker could `POST /forgot-password` with someone else's
  address in the body and `Host: attacker.tld`, and the app would mail _that
  person_ a genuine, single-use reset link pointing at the attacker's server. The
  victim sees a legitimate mail from the real service; one click — or one
  link-prefetching mail scanner — hands over the token, and `ResetPasswordController`
  accepts it with no session binding or second factor.

  Scaffolds now route every emailed link through a generated `app/Auth/AppUrl.ts`,
  which reads `APP_URL` and **fails closed in production** rather than falling back
  to the request. Development keeps working with no configuration. The three email
  verification sites got the same treatment: they mail the requester's own address,
  so they were not exploitable, but they were the same pattern.

  Templates also stop disabling host authorization in production. It was
  `process.env.NODE_ENV === 'production' ? false : { ... }`, which removed the
  middleware in exactly the environment that needed it; the production branch now
  derives its allowlist from `APP_URL`'s hostname, and health-check paths stay
  excluded so load balancers reaching the app by IP are unaffected. When `APP_URL`
  is not readable at module scope the template warns and leaves the check off
  rather than throwing — the Cloudflare worker imports the app before wrangler
  `vars` reach `process.env`, and a throw there would stop the app booting at all.
  `guren audit` now also flags `hostAuthorization: false`, which it previously
  walked past while the templates themselves shipped it.

  In `@guren/server`, a `host:*` allowlist entry now means "this host on any
  **port**". `compileHostMatcher` accepted anything after the colon, so
  `example.com:*` also matched a `Host` of `example.com:attacker.tld`. The same
  middleware stops re-parsing the whole request URL to read its path on every
  request, which it now does in production rather than only in development.

  **Action required for new apps:** `APP_URL` must be set in production. It is
  already present in the scaffolded `.env.example`. Existing apps are unchanged —
  if yours has a `ForgotPasswordController` generated before this release, apply
  the same change by hand, or re-run `guren add auth --force`.

- b27a6cd: Accept controller actions alongside route contract options inside `router.middleware(...)` chains

  `router.middleware('auth').post('/posts', { name: 'posts.store', body: Schema }, [PostController, 'store'])`
  raised TS2769 even though it worked at runtime: the middleware-scoped builder carried only
  two overloads per HTTP verb, missing the contract-options + `[Controller, 'method']` variant
  the router itself has. All five verbs now expose it, so the direct chain no longer needs a
  `.group()` wrapper to compile.

  Route docs and the `make:feature` next-steps hint now capture the `aliasMiddleware()` return
  value, which later `.middleware()` calls require — a bare call registers the handler at runtime
  but leaves the alias name invisible to the type system.

- Updated dependencies [fe70ee7]
  - @guren/orm@2.1.0

## 2.0.0

### Major Changes

- cda337b: Structural mass-assignment protection (RFC 0006).

  BREAKING CHANGE: `Model.guarded` and `Model.strictFillable` are removed.
  `fillable` is the single allowlist and is always strict; the primary key
  (`id`) is always silently stripped from mass-assignment input. Models can
  contribute always-denied fields via the new `deniedFields()` hook —
  `AuthenticatableModel` denies its resolved password-hash and remember-token
  columns (new `rememberTokenField` static), so a request body carrying them
  throws a `MassAssignmentException` (new `reason: 'denied' | 'not-fillable'`
  property) regardless of `fillable`. Use `forceCreate()`/`forceUpdate()` for
  trusted server-side values such as `passwordHash: 'oauth:...'`.

  `ModelUserProvider` now reads credential column names from the model contract
  (`resolvePasswordHashField()`/`resolveRememberTokenField()`, now public) when
  the target extends `AuthenticatableModel`; explicit options remain as
  overrides. `AuthManager.useModel()` no longer hardcodes them.

  `defineModel()` drops the deprecated `createType` option (use
  `optionalOnCreate`/`requireOnCreate`), and `AuthenticatableModel.createType`
  no longer widens to `PlainObject` — models extending it directly should
  declare their own `createType`; `defineModel()`-based models are unaffected.

  CLI: `make:auth` stops emitting the now-redundant `guarded` line;
  `guren check` fails on models declaring `guarded`/`strictFillable` and on
  `fillable` listing a denied credential column; `guren audit` recognizes
  structurally protected auth models and warns when a controller method mixes
  `validateBody` with `forceCreate`/`forceUpdate`; `guren upgrade --check-only`
  detects the removed statics.

### Patch Changes

- d7e80fe: Identify hot-reload owners correctly when a path or a function name contains
  parentheses

  Under `bun --hot`, both packages key what a reload must tear down — timers for
  cache stores, schedulers, rate limiters and broadcast managers; clients for
  database connections — on the file that built it, read out of a stack frame
  whose location is wrapped in parentheses: `at make (/app/x.ts:3:1)`.

  `@guren/server` could not read that shape at all when the path itself
  contained parentheses, which is an ordinary macOS directory name
  (`~/Projects (2024)`). The rejected frame was not simply lost: the frame walk
  falls through to the next frame that does parse — a _different_ file, further
  out — so two owners reached from one place shared a slot, and building the
  second stopped the first's live timer.

  `@guren/orm` could read a path with parentheses, but by taking the frame's
  _leftmost_ `(` — which gets the wrong pair when the _function name_ in front
  of the location has parentheses instead. Bun emits exactly that shape for a
  method whose key carries them: `at weird (name) (/app/x.ts:3:1)`. Leftmost
  matching reads that as `name) (/app/x.ts`, which is not a path but is stable
  enough to be used as a key — worse than losing the frame, because on the
  server side the same rule also swallows the `unknown` marker of an implicit
  constructor, defeating the filter that stops every such owner from collapsing
  into one slot.

  Neither the leftmost nor the rightmost `(` is right in general — a path with
  parentheses needs the first, a function name with parentheses needs the last.
  Both packages now find the location by scanning back from the frame's final
  `)` and counting nesting depth, so it is bounded by whichever parenthesis
  actually matches it. Frames without parentheses in either position parse to
  exactly what they did before.

  An `eval` frame — `at eval (eval at <anonymous> (/app/x.ts:1:2), <anonymous>:1:1)`
  — is now rejected outright rather than read as a path: the location it
  contains belongs to the `eval` call site, not to the owner under construction,
  and using it as a key would drift on any edit to the line the `eval` occurs
  on. An owner with no key is left alone, which is the safe failure everywhere
  else in these registries.

- Updated dependencies [63fd323]
- Updated dependencies [e2c82da]
- Updated dependencies [d7e80fe]
- Updated dependencies [df90e04]
- Updated dependencies [cda337b]
  - @guren/orm@2.0.0

## 1.5.0

### Minor Changes

- e5b8688: feat: let jobs pin their durable wire identity

  Queue identity was derived entirely from the class name — registration,
  dispatch, and worker lookup all keyed on `jobClass.name`. That breaks a queued
  message whenever the class name changes between the write and the read: a class
  renamed while a backlog drains, or a bundler that mangles identifiers. The
  Vercel plugin hit the second case in production and was fixed at the bundler
  level, but that fix does not reach a user running their own esbuild or rollup
  over a Guren app.

  Jobs may now declare a stable wire name:

  ```ts
  export class SendWelcomeEmailJob extends Job<{ userId: string }> {
    static jobName = "SendWelcomeEmailJob";
  }
  ```

  `registerJob()` and `Job.dispatch()` resolve the name through a new exported
  `resolveJobName()` helper, which `@guren/testing`'s `FakeQueue` uses as well so
  the fake keys jobs exactly as the real driver does. Jobs without a `jobName`
  keep resolving by class name — this is opt-in and backward compatible.

  Only an **own** `jobName` counts. Statics are inherited, so resolving through
  the prototype chain would make every subclass of a pinned job claim its
  parent's identity and evict it from the registry. A subclass that wants to
  share the parent's wire name declares it explicitly.

  ### Upgrading

  The framework's own jobs now declare a `jobName`, pinning their wire name
  against future bundler mangling. In a normal, unmangled build this is a no-op —
  the declared name already equals the class name for both `SendMailJob` and
  `SendNotificationJob` — so it only matters going forward. **If a previous
  deploy was bundled with identifier mangling**, those jobs were queued under the
  mangled name (`a`, `t`, …) and will not resolve against the now-declared one;
  drain the affected queues before upgrading.

  `@guren/testing` now imports `resolveJobName` from `@guren/server`. Its
  `@guren/server` peer range stays at `>=1.0.0` — tightening it would only be
  satisfied once `@guren/server` itself is released at the
  version shipping this feature, which breaks workspace linking against the
  not-yet-released version in the meantime, and `.changeset/config.json`'s
  `onlyUpdatePeerDependentsWhenOutOfRange` deliberately keeps this range wide so
  routine `@guren/server` bumps don't force a spurious major on `@guren/testing`.
  Pair a current `@guren/testing` with a current `@guren/server`.

- 27137f9: Console commands are wired up automatically, and `guren check` reports the ones that are not.

  `make:command` wrote a class and printed the registration step for the user to
  perform by hand. Forgetting it left dead code with no signal — the same bug the
  console entrypoint was added to fix, recurring once per generated command.

  `make:command` now performs that wiring: a project-level command is imported
  and appended to `kernel.registerMany([...])` in `src/console.ts`, and
  `bunx guren check` warns about any command class a console entrypoint never
  uses outside its imports.

  `defineModule()` gains a `commands` field alongside `routes` and `providers`,
  so a module's commands reach the root kernel through its public surface:

  ```ts
  // modules/billing/index.ts — make:command --module billing writes this
  export const billingModule = defineModule({
    name: "billing",
    commands: [InvoiceCommand],
  });

  // src/console.ts — add once per module
  kernel.registerMany(billingModule.commands);
  ```

  Previously the only route was re-exporting the command from the module's
  `index.ts`, because importing it directly from `src/console.ts` reaches into
  module internals and fails `guren check --arch`.

  `guren context` now lists console commands, which were invisible to it before.

### Patch Changes

- ba3aae4: Fix queued notifications delivering nothing

  A notification with `static shouldQueue = true` was queued and picked up by the
  worker, but no channel was ever invoked. Serialization spread the notification
  into a plain payload (`{ ...notification }`), which copies only own enumerable
  properties — `via`, `toMail`, `toDatabase` and `toSlack` all live on the
  prototype and were dropped. The job handler then rebuilt a shim that read the
  delivery channels from a `_viaChannels` field nothing ever wrote, so `via()`
  returned an empty list and the send loop had nothing to iterate. The
  synchronous path was unaffected.

  Queued notifications are now rebuilt as real instances. Notification classes
  are recorded in a registry keyed on `notification.type` and restored with
  `Object.create(prototype)`, which brings back every prototype method without
  re-running the constructor (constructor arguments are not recoverable from a
  payload). Registration happens automatically when a notification is queued,
  which covers a worker sharing the dispatching process; a worker in a separate
  process should call the newly exported `registerNotification()` at boot, and an
  unregistered type now throws instead of failing silently.

  Routing survives the queue too. The worker used to guess a notifiable's routes
  from a `${channel}Route` property convention that the documented `Notifiable`
  does not follow, so a queued notification to a user routing Slack via
  `this.slackId` silently fell back to the org-wide webhook. `routeNotificationFor()`
  is arbitrary user code — frequently a closure on an object literal — and cannot
  be rebuilt from a payload, so it is now called at dispatch and the resolved
  routes travel with the job. Payloads written before this release still fall
  back to the old convention.

  The job itself was also unreachable from a dedicated worker. It was registered
  only as a side effect of dispatching, under the name of an internal per-manager
  subclass, so `guren queue:work` running as its own process failed every
  notification with `Job class not found`. That subclass is gone — since the
  queue registry keys on the class name, every manager overwrote the same entry
  anyway — leaving one `SendNotificationJob` that `NotificationServiceProvider`
  registers on boot via the new `NotificationManager#registerQueueJob()`.

  Also: `createdAt` is serialized explicitly and revived as a `Date`, so drivers
  that persist JSON (Redis, SQS) no longer hand channels a string. `Notifiable`
  gained an optional `notifiableType`, honored by `DatabaseChannel` through the
  newly exported `resolveNotifiableType()`, so a notifiable rebuilt from a
  payload keeps its original type name instead of recording `Object`.

  Because rebuilt notifications are real instances, a user-defined `shouldSend()`
  is now honored on the queued path; the previous shim hardcoded it to `true`.

- Updated dependencies [a7aec95]
- Updated dependencies [7d18f07]
- Updated dependencies [f448a0a]
  - @guren/orm@1.3.0

## 1.4.0

### Minor Changes

- 5196935: Added application modules — a `modules/<name>/` directory convention for composing self-contained slices of an app instead of piling everything into one flat `app/`, `routes/`, and `db/schema.ts`. `defineModule()` (new in `@guren/server`, re-exported from `@guren/core`) declares a module's routes and providers; `Application` folds them into its provider list and route mounting at boot via the new `mountModuleRoutes()`.

  On the CLI side: `guren make:module <name>` scaffolds and auto-wires a module (`index.ts`, `routes.ts`, `db/schema.ts`, plus `src/app.ts`/`db/schema.ts` patching). Most `make:*` generators accept `--module <name>` to scaffold inside a module instead of the project root. `guren check`, `guren audit`, `guren context`, `model:list`, and `doctor` are all module-aware automatically, and once any `modules/` directory exists, `guren check` derives zero-config boundary rules that flag cross-module imports reaching past a module's public surface (`index.ts` or `db/schema.ts`) — no `guren.arch.ts` authoring required. `guren codegen`, `guren audit`, `openapi:generate`, and `guren route:list` all see routes registered inside a module's own `routes.ts`, not just the top-level `routes/web.ts`.

- 0138070: feat: entity-centric context bundles (RFC 0004 Part 1)

  - `guren context <Entity>` joins everything the CLI knows about one model
    into a single markdown/JSON bundle: model metadata (table, columns,
    relationships, reverse references), routes with validation schemas,
    controller actions, Inertia pages with extracted Props, resource,
    policy, factories, seeders, and tests. Same-named models across
    modules are disambiguated with `--module` (`--module app` selects the
    application root), and every join is scoped to the selected location
    when the name is duplicated.
  - `guren context` (whole-project) now reports routes from the full
    `RouteDefinition` payload — the Routes table gains a Controller column
    and JSON output includes controller bindings and schema type strings.
  - `RouteDefinition` gains `bindings` (param name → bound model class
    name) so route model bindings are introspectable.
  - The MCP endpoint exposes the bundle as the `guren_entity_context` tool
    and the `guren://context/{entity}` resource template.

- 97aa6c7: Let apps configure the server-rendered Inertia document through `setInertiaDocument()`.

  The `<body>` class and the critical CSS inlined into `<head>` were hardcoded to page components named `Docs/*`. Any other page whose theme is applied by a client effect painted the stylesheet's default surface color first and only corrected itself once React hydrated — a visible flash on the very first frame.

  `setInertiaDocument({ bodyClass, criticalCss, prepaintScript })` moves that decision to the app. Each field takes a string or a function of the page component, so a docs section can claim a light surface while marketing pages keep a dark one. The same three fields exist on `InertiaOptions` for per-response overrides. Call it at module scope in the app entry so every runtime — the Bun server, serverless handlers, generated worker bundles — picks it up.

  The old `Docs/*` special case is gone, but no scaffold or template ever emitted a page component under that name, so nothing needs migrating:

  ```typescript
  setInertiaDocument({
    bodyClass: ({ component }) =>
      component.startsWith("Docs/") ? "docs-theme" : undefined,
  });
  ```

- 88e6d4f: fix: make the `guren_codegen` MCP tool regenerate changed artifacts

  The tool called the CLI generators without `force`, so as soon as a route
  changed — the one case where regeneration matters — the writer refused with
  "already exists. Use --force to overwrite." A blanket `catch {}` per generator
  swallowed that, and the tool reported `{"generated": []}` as a success. It now
  passes `force: true`, the way `guren codegen` already does, since these
  outputs are generated artifacts that exist to be overwritten.

  Skips are no longer silent. The response carries a `skipped` array naming each
  artifact and the reason it was not produced, and a generator that throws now
  marks the whole run as an error even when other artifacts were written. A
  generator that simply found nothing to describe — an app with no page
  components, for instance — is reported as a skip rather than a failure.

  The tool also generates `.guren/api-client.gen.ts`, which it previously left
  out even though `guren codegen` produces it. Because the API client is built
  from the route manifest, an agent that added a route through MCP got every
  other artifact refreshed while the client silently went stale.

- f7186c7: Add `fetchFallbackEmail` to `OAuthProviderConfig`: an optional async hook consulted when the userinfo response carries no email. `createGitHubOAuthProviderConfig` now supplies a default implementation that fetches the primary verified address from GitHub's `/user/emails` endpoint — GitHub returns `email: null` for accounts with a private email even when the `user:email` scope was granted, which previously made OAuth sign-in fail for those accounts.
- 10a9bd1: Add `emailVerified` to `OAuthUserProfile`. Providers report whether they actually verified an address separately from the address itself — Google sends OIDC's `email_verified`, Discord sends `verified` — and until now that signal was only reachable through the untyped `profile.raw` bag. The field is tri-state on purpose: `true` (the provider asserts verified), `false` (it asserts not verified), `undefined` (no signal, so the app decides its own policy).

  Provider configs declare where to read it via `emailVerifiedKey`, so the shared mapper knows only OIDC's standard `email_verified` claim; the Google and Discord presets each declare their own key, and only boolean values are read. GitHub's `/user` carries no such field, so `emailVerified` stays `undefined` there — except when the private-email fallback runs, which reports `true` because `/user/emails` only yields verified primary addresses. `mapProfile` still owns the whole mapping when set.

  `fetchFallbackEmail` may now also return `{ email, emailVerified }` instead of a bare string, since the signal read from the userinfo response cannot vouch for an address that response did not contain. This is additive: implementations written against the original signature keep compiling, and a bare string deliberately claims nothing, leaving `emailVerified` undefined rather than asserting `true` on their behalf.

  `make:auth --oauth`'s scaffolded `OAuthController` now checks `profile.emailVerified === false` instead of matching provider-specific keys on `profile.raw`. Same behavior, no provider names in generated application code.

- db4450e: Added `@guren/plugin-cloudflare` — the Cloudflare Workers deploy adapter (RFC 0003 Part 1). `createWorkersHandler(app)` wraps a Guren `Application` in a Workers module handler with lazy, deduplicated boot on the first request (bindings arrive with `fetch`, so boot cannot run at module scope) and passes each request's `env`/`ExecutionContext` through to Hono untouched. `getWorkersEnv<Env>()` exposes the first request's bindings to boot-time config behind a write-once holder, and `guren cloudflare:build` assembles a deployable `.cloudflare/` directory: the app's canonical build, a generated worker entry that statically wires the built SSR bundle, copied static assets for Workers Static Assets, and a `wrangler.jsonc` scaffold (D1 binding, `nodejs_compat`, drizzle migrations dir).

  The plugin's provider follows the `definePlugin()` factory shape (`cloudflarePlugin()` — configuration reserved for upcoming session/OAuth-state wiring), so there is no auto-registered class provider; the CLI command works regardless via the `gurenPlugin.commands` manifest.

  Supporting additions: `setInertiaSsrRenderer()` in `@guren/server` registers a process-wide default SSR renderer (per-call `ssr.render` still wins) so filesystem-free runtimes can use a static import instead of the `GUREN_INERTIA_SSR_ENTRY` dynamic import, and `TestApp.fromWorkers(handler, { env })` in `@guren/testing` drives a Workers-style handler with a fake `ExecutionContext` for testing the lazy-boot lifecycle.

- 1a6b738: Reduced session write volume (RFC 0003 Part 3): the session middleware no longer persists on every request, which matters anywhere writes are metered (Cloudflare D1's free tier allows 100k row writes/day — previously every page view consumed one).

  - **Empty new sessions are not persisted and issue no cookie.** An anonymous request that never stores anything now costs zero store operations. Sessions (and their cookie) appear the moment anything is stored. Apps that relied on every visitor receiving a session cookie unconditionally will see it appear on first actual session use instead. (With the default auth stack this happens on the first CSRF-protected page, unchanged for now.)
  - **Flash aging only dirties sessions that carried flash data**, instead of marking every loaded session dirty on every request.
  - **New optional `SessionStore.touch(id, ttlSeconds)`** — rolling expiry for unchanged sessions becomes a TTL refresh instead of a full data rewrite. Implemented in `MemorySessionStore`, `RedisSessionStore` (EXPIRE), and `DatabaseSessionStore` (single UPDATE). Stores without `touch` keep the previous full-write fallback, and touching a missing session is a no-op — an expired session is no longer resurrected as an empty row by its stale cookie.

- f60c041: CSRF protection moves out of the session into signed tokens (RFC 0003 Part 3), using the app keyring via `MessageSigner` (`APP_PREVIOUS_KEYS` rotation supported). The token is **bound to the session** when a logged-in one exists and **stateless double-submit** for guests:

  - **Logged-in (session-bound):** the token carries the session id and is verified against the live session — immune to cookie injection, including a sibling-subdomain attacker who plants their own validly-signed token (it is bound to _their_ session id, not the victim's). This preserves the security posture of the previous session-stored token.
  - **Guest (stateless):** a signed random token verified against the `XSRF-TOKEN` cookie. Guests hold no authenticated state to protect, and nothing is stored server-side — so anonymous page views cost zero session writes and no session cookie. Completing the write-volume work, a guest GET + form POST roundtrip now performs no session store operations at all, which is what makes the default auth stack viable on write-metered databases like Cloudflare D1's free tier.

  The CSRF middleware no longer requires session middleware to be registered; `getCsrfToken()` no longer throws without it. `cookie: false` now works for session-authenticated flows (bound tokens verify without the cookie). Tokens stored in sessions by earlier releases keep verifying via a legacy fallback until those sessions expire, so in-flight sessions survive the upgrade — no action required.

### Patch Changes

- b49e052: Report unhandled exceptions to the console when no reporter is registered.

  An app that never called `reporter()` turned a 500 into a rendered error page and nothing else. On a hosted runtime, where stdout is the only channel back to the operator, that left production failures with no trace to follow — the cause could only be found by bisecting the code. Anything that registers a reporter still owns reporting entirely; this only fills the empty case.

- 7fc5692: Fixed leaked interval timers under `bun --hot`. Each hot reload re-runs the module graph in the same process, and a `setInterval` callback keeps its owner reachable — so the cache sweep, rate-limit cleanup, SSE ping, and scheduler timers built by the previous evaluation went on firing against objects nothing referenced any more, one extra timer per reload. The rate-limit and SSE timers are not `unref()`ed, so those also duplicated work and held the process open on their own; a duplicated scheduler would have run every scheduled task twice per reload. Each owner now parks its teardown on a `globalThis` registry — the same approach `Application.listen()` already uses for the Bun and Vite dev servers — and stops its predecessor before taking over.

  This only applies under `bun --hot`. An owner is identified by the file that built it plus a discriminator (the cache store's name, the rate-limit store's class, the scheduler's timezone), so it is replaced only by a later evaluation of that same file. Nothing is ever torn down automatically in production, tests, CLI commands, or serverless.

  Three things to know. Cache stores are tracked from the cache configuration, so a store built by calling `new MemoryStore()` directly in application code is not covered — every path the templates and examples take goes through cache config. Broadcast managers are tracked from `createBroadcastManager()`, so a bare `new BroadcastManager()` is likewise left alone. And because every manager built through `createCacheManager()` reports that factory as its call site, the store name is the whole of a cache store's identity: two cache managers in one process would share a slot per store name, so the second store under a given name stops the first one's sweep. Apps have one cache manager.

  As part of this, `BroadcastManager` gained a public `disconnectAll()` that closes every SSE connection it is holding, which is what stops those connections' ping timers.

- Updated dependencies [360d1f4]
- Updated dependencies [a2c7b8c]
- Updated dependencies [d5d0c5b]
  - @guren/orm@1.2.0

## 1.3.0

### Minor Changes

- 9576668: Add `definePlugin()` helper for authoring configurable plugins without ServiceProvider boilerplate. Each factory call returns an independent provider class with the configuration captured in a closure, so the same plugin can be registered multiple times with different configurations — replacing the unsafe static-config pattern previously shown in the plugin authoring guide. Supports `deferred`/`provides` for lazy loading. Exported from `@guren/core` alongside `PluginDefinition` and `PluginFactory` types. (RFC 0001, Part A)

  `ProviderManager.register()` now throws when a deferred provider declares no `provides` services — previously such a provider was silently dropped and could never load.

- 15b4be0: Add `detectLocaleMiddleware`: resolves the request locale from the `?locale=` query parameter, a `locale` cookie, or the `Accept-Language` header (region subtags and q-values understood), restricted to a supported-locales allowlist. Sets the `locale` context variable — feeding the `<html lang>` attribute of Inertia responses — and binds request-scoped `t`/`tc` translator helpers when an i18n manager is available (the `setI18n()` global, or one passed via the `i18n` option). Also fixes the `<html lang>` i18n fallback in `Controller.inertia` to read the router-injected container (the previous context-variable lookup never fired in real apps).
- 6e0efe2: Guard OAuth `redirectTo` against open redirects. State creation and verification both sanitize the value: app-relative paths always pass, absolute URLs only when their host is in the new `stateConfig.allowedRedirectHosts` allowlist (wildcards supported); protocol-relative URLs, backslash variants, and non-http schemes are dropped. New `OAuthManager.handleCallback()` returns the profile together with the sanitized `redirectTo`, and `sanitizeOAuthRedirect()` is exported for custom flows. The `guren add oauth` scaffold now demonstrates the safe round-trip (`?redirectTo=` → `handleCallback`).
- 7683c66: Add the `Sanitized<T, Hidden>` type helper (and `DefaultSanitizedKeys`). `auth.user()` sanitizes records at runtime — the password column, remember-token column, and the model's `static hidden` fields are stripped — but the type previously still claimed those fields were present. `auth.userOrFail<Sanitized<UserRecord>>()` strips the conventional credential keys from the compile-time type (distributing over union records); columns with non-conventional names and extra hidden fields go in the second type parameter (`Sanitized<UserRecord, 'twoFactorSecret'>`).
- b1098cf: Wire `TestRequestBuilder.withSession()` to server-side session hydration: the session middleware now reads the `X-Testing-Session` header — only when `GUREN_TESTING` is set, same gate as `X-Testing-User` — parses the JSON payload, and merges it over the stored session data for the request. Tests using `createTestClient(...).get(...).withSession({ ... })` now observe the injected session state instead of an empty session. Malformed or non-object payloads are ignored.

## 1.2.0

### Minor Changes

- 7a30cb5: Localize the root `<html lang>` attribute of Inertia responses. Controllers can set it per response with `this.inertia(page, props, { lang: 'ja' })`, and when the option is omitted it is derived automatically: a request-scoped `locale` context variable (set by locale-detection middleware via `c.set('locale', ...)`) wins over the app-wide i18n locale (`I18nServiceProvider`), falling back to `"en"`.

## 1.1.0

### Minor Changes

- bc79a6a: Resolve the `@/` alias from the project root instead of `app/`. The Vite plugin alias, scaffolded imports (`make:*`, `add resource`), and docs now use root-relative paths like `@/.guren/pages.gen` and `@/app/Http/Resources/PostResource`, removing deep `../../..` relative imports. `guren doctor` gains a `tsconfig-alias` check with autofix. Apps created before this release should update `tsconfig.json` paths to `"@/*": ["./*"]` so newly scaffolded code resolves.

### Patch Changes

- bc79a6a: Auto-register `InertiaServiceProvider` after user providers. Validation errors on Inertia requests are now redirected with the error bag as expected instead of returning a raw JSON 422 that triggered the Inertia error modal. Apps that registered the provider explicitly keep working unchanged.
- f12e754: Fix Inertia SSR on serverless deployments and stop shipping dev import maps in production.

  - The Guren Vite plugin now defaults `ssr.noExternal` to `true` for SSR builds so `.guren/ssr` bundles are self-contained and importable on runtimes without `node_modules` (Vercel, Lambda).
  - `@guren/plugin-vercel` pins `process.env.NODE_ENV` to `"production"` when bundling the function entrypoint; `bun build` otherwise inlines it as `"development"`, disabling every production code path at runtime.
  - The Inertia HTML document no longer emits the esm.sh dev React import map when `NODE_ENV` is `production`.

- Updated dependencies [bc79a6a]
  - @guren/orm@1.0.1

## 1.0.0

### Major Changes

- 73d311c: v1.0 Release Candidate

  New subsystems: OAuth, MySQL adapter, typed broadcasting, OpenAPI generation,
  production error pages, request ID/logging middleware, plugin test harness,
  API-only and worker starter kits.

  DX: Golden path standardization, doctor autofixes, CLI consistency,
  upgrade productization, security defaults.

  Quality: Playwright E2E, CI matrix, nightly canary, benchmarks,
  smoke tests for all starter kits.

  Docs: Task-completion guides (en/ja), plugin authoring guide,
  deployment recipes (Docker, Fly.io, VPS, serverless).

  Governance: API stability tiers, deprecation policy, SemVer guidance,
  RFC process, release cadence, issue triage SLAs.

### Minor Changes

- d3a0d2c: DX fixes from the i18n dogfooding lap:

  - **Middleware `c.header()` now reaches controller responses.** Handlers and controllers return raw `Response` objects, which bypassed Hono's response construction — headers staged via `c.header()` in upstream middleware (e.g. a locale cookie) were silently dropped. Route responses are now rebuilt through `c.newResponse()`, merging prepared headers (`Set-Cookie` appended, the handler's own headers winning otherwise).
  - **`TestApp.withHeaders()` / `withHeader()`**: send custom request headers on every request (Accept-Language, bearer tokens, …). Like `actingAs()` and `json()`, they return a new `TestApp` and compose freely.
  - **`shareInertiaProps()`** merges shared props over previously registered resolvers, so multiple providers can each contribute (auth, i18n, flash, …) without clobbering one another. `getInertiaSharedPropsResolver()` is now exported for manual composition.
  - **Docs**: global middleware must be attached in a provider's `register()` — routes mount before `boot()`, so `app.use()` from `boot()` never applies. Documented in the architecture guide (en/ja).

- 379d57e: First-class file uploads:

  - **`this.file(name)` / `this.files(name)` controller helpers** — read uploaded files from multipart requests (null/empty-safe, composes with other body reads via Hono's cached parseBody). Previously controllers had to call `this.request.parseBody()` and duck-type the result.
  - **`TestApp` accepts `FormData` bodies** — `csrf.post('/tasks/1/attachments', formData)` sends real multipart requests, so upload endpoints are finally testable.

- 57f6f35: Fixes and features from building a real app (Kadai) on the published packages:

  - **@guren/server: entry bundles now share chunks** (tsup `splitting: true`). Each entry point previously bundled its own copy of module-level state, so `registerJob()` via the root entry and `Worker` via `./queue` used different job registries — jobs failed with "Job class not found". The same duplication affected the mail manager and queue driver globals.
  - **@guren/server: new `SyncDriver` (queue) and `LogTransport` (mail)** — the template `.env` defaults (`QUEUE_CONNECTION=sync`, `MAIL_MAILER=log`) previously named drivers that did not exist. Sync dispatch executes jobs inline with no worker process; the log transport writes full messages to server output. The `add queue` / `add mail` blueprints now honor these env vars and default to sync/log.
  - **@guren/orm: multi-relation type fix** — `findWith(id, ['a', 'b'])` and `with(['a', 'b'])` typed their results as a union of single-relation picks instead of an intersection, making relation properties inaccessible.
  - **@guren/orm: `QueryBuilder.paginate()` accepts an options object** (`{ page, perPage }`) in addition to positional arguments, matching `Model.paginate()`.

- 7fbf1de: Accept Hono middleware as a terminal route handler:

  - **`RouteHandler` now includes `(c, next)` signatures**, so any Hono `MiddlewareHandler` — including `broadcast.sseMiddleware()` and `broadcast.authMiddleware()` — can be passed directly to `router.get()` / `router.post()` as the docs show, without wrapper closures or `as Promise<Response>` casts.
  - **Responses set via `c.res` are honored**: a middleware mounted as a handler that finalizes the response through `next()` or `c.res =` no longer gets clobbered by a synthesized `204 No Content`. Plain handlers returning `undefined` still produce `204`.

- c10691c: Three bug fixes ahead of 1.0:

  - **Nested eager loading now works at any depth** (#15). `User.with('posts.comments.author')` previously loaded two levels and silently left deeper relations unloaded when going through the query builder. `QueryBuilder` now delegates the full dotted path to `Model.loadRelationInto`, which recurses correctly.
  - **Auth context is available to middleware registered before `boot()`** (#13). The fallback auth context (apps without `options.auth`) is attached in the `Application` constructor, and the context resolves its session lazily — so `app.use(requireAuthenticated())` before `boot()` responds 401 instead of throwing, regardless of session middleware ordering.
  - **Route contracts accept array-style query strings** (#12). `?tag=a&tag=b` now reaches query schemas as `{ tag: ['a', 'b'] }` (single occurrences stay plain strings), matching the controller-side `validateQuery` behavior. Schemas that expect a plain string for a key clients may repeat should switch to `z.array(...)` or accept both.
  - **`guren add oauth` now generates code that compiles.** The scaffolded controller named its action `redirect`, shadowing the base `Controller.redirect()` helper (infinite recursion) and failing to typecheck; the route-param validator also rejected `string | undefined`. The action is now `redirectToProvider` and the validator handles missing params.

- a1fc6ec: Two security defaults locked in ahead of 1.0:

  - **Strict mass assignment.** When a model defines `fillable`, `create()`/`update()` now throw a `MassAssignmentException` naming any field outside the allowlist instead of silently discarding it (silent drops surfaced as NOT NULL violations far from the cause, and masked injection attempts). Use the new `forceCreate()` / `forceUpdate()` for trusted server-side data, or set `static strictFillable = false` per model to restore the old behavior. The `guarded` path is unchanged.
  - **`auth.user()` never exposes credentials.** The session guard sanitizes user records before caching or returning them: the password column, remember-token column, and the model's `static hidden` fields are stripped. Credential checks still run on the raw record internally, so login and remember-me behave exactly as before — but sharing `auth.user` into Inertia props no longer leaks `passwordHash` to the browser. Custom user providers can opt in via the new optional `UserProvider.sanitize()`. `guren add auth` now generates the User model with `static hidden = ['passwordHash', 'rememberToken']`.

- f7de890: Final API freeze pass before 1.0, driven by an adversarial pre-release review:

  - **`QueryBuilder.update()` now enforces the fillable allowlist** exactly like `Model.update()` (it previously bypassed mass-assignment protection entirely); `QueryBuilder.forceUpdate()` is the trusted-data escape hatch.
  - **Redis stores are now importable**: `@guren/core/redis` (and `@guren/server/redis`) ship `RedisSessionStore`, `RedisRateLimitStore`, `RedisSlidingWindowRateLimitStore`, `RedisApiTokenStore`, `RedisPasswordResetStore`, `RedisEmailVerificationStore`, and the new `RedisOAuthStateStore`. The default `MemoryOAuthStateStore` is now bounded (10k entries with expiry sweep) to prevent memory-exhaustion DoS.
  - **`PaginationMeta` name collision resolved**: the ORM's pagination meta is now `ModelPaginationMeta`; `PaginationMeta` from `@guren/core` unambiguously refers to the resource/paginator shape.
  - **React is a peer dependency**: `@guren/inertia-client` moves `react`/`react-dom` to peerDependencies, and `@guren/server` makes `@guren/inertia-client` an optional peer — API-only apps no longer pull React transitively.
  - **`@guren/testing/vitest` subpath**: vitest/React helpers move out of the root barrel so `bun:test` users don't need the React test stack; the related peer deps are marked optional.
  - **`Hash` is runtime-safe**: it now points at `DefaultHasher`, which delegates to Bun's scrypt on Bun and the Node implementation elsewhere (Lambda on Node no longer crashes).
  - Smaller freeze items: `ApplicationOptions`/`AuthPluginOptions` exported, unimplemented `Command.callSilent()` removed, `FormRequest` marked `@deprecated`, `MemoryQueueDriver`/`SyncQueueDriver`/`RedisQueueDriver` aliases added, internal ORM plumbing removed from the `@guren/core` allowlist, `nodemailer` bumped to v9 (HIGH advisory), stray `./dist/*` export wildcard removed.
  - **Docs**: broadcasting client flow rewritten around the `connected` handshake and `clientId` subscription (the previous example authorized but never subscribed), array-style query params documented, rc → 1.0.0 migration notes added, MySQL support matrix corrected, rate-limiting/serverless guides point at the shipped Redis stores.

- a835522: Secure-by-default hardening and AI-agent tooling:

  - `guren audit` command: validates auth/validation coverage on mutating routes, detects raw SQL, secrets, and mass assignment risks
  - `make:feature` now scaffolds auth checks by default (`--public` to opt out) and supports `--policy`
  - Authorization gate wiring, hardened auth/storage/mail/error rendering
  - Inertia asset version mismatch handling
  - drizzle-orm / drizzle-kit upgraded to 1.0.0-rc.1
  - Migration tracker SQL escaping fix and dependency vulnerability patches

- 42c6053: Make SSE broadcasting actually reachable from clients:

  - **The SSE stream announces the connection** with a `connected` event carrying the `clientId` and any already-subscribed channels. Previously clients had no way to learn their id, and no HTTP path ever subscribed a client to a channel — SSE connections received pings but never a single broadcast event.
  - **`?channels=a,b` query subscriptions** on the SSE endpoint: requested channels are authorized against the connecting user (`sseMiddleware({ getUser })`) and subscribed before the stream starts, so a bare `EventSource` works for public channels.
  - **`POST /broadcasting/auth` subscribes as well as authorizes** when the payload includes the `clientId`, returning `{ authorized, subscribed }` per channel.
  - **Unregistered `private-`/`presence-` channels now default to deny** instead of public access — a missing channel registration no longer silently exposes a private channel.

- ac73182: Added SSR support, ORM relationships, pagination, and authentication enhancements.

### Patch Changes

- c2f318d: Align all packages to rc.10.
- e74eab5: fix(ci): upgrade to Node 24 for npm OIDC trusted publishing
- dcee3ee: fix(server): use figlet importable-fonts for bundled builds
- b3c9414: feat(cli): add @guren/plugin-vercel and remove legacy deploy vercel target
  fix(create-app,orm,cli): fix blog blueprint SQLite support and DX issues
  fix(create-app): comment out VITE_DEV_SERVER_URL in template .env
- 73d311c: Align all packages to rc.9.
- 5fbd7e7: Pinned dependencies to specific versions for consistency across packages
- 83ca2c2: Fix critical scaffold-to-runtime breakages found by dogfooding the published packages:

  - **@guren/server**: stop bundling `@guren/orm` (now a real dependency). The bundled copy created a second `Model`/`DrizzleAdapter` instance, so `configureOrm()` never reached `AuthenticatableModel` and every auth query failed with "database has not been configured" in published apps.
  - **@guren/cli `add auth`**: schema updates and the users migration now respect the app's database dialect (sqlite/postgres/mysql) instead of always emitting Postgres SQL; the migration is generated via drizzle-kit instead of a loose `.sql` file that `db:migrate` never executed; `createApp()` is patched with `auth: {}` so sessions and CSRF actually mount.
  - **@guren/cli `add resource`**: honors `--fields` (previously silently ignored) and adds `--public`; delegates file generation to the `make:feature` templates; registers the route group with typed body contracts — the previous insertion regex never matched the starter template, so routes were silently never registered.
  - **@guren/cli `codegen`**: generates route/data/channel/API-client artifacts by default (previously skipped silently unless `--routes` was passed, leaving `routes.gen.ts` empty).
  - **@guren/orm**: warn when the migrations folder contains loose `.sql` files that the drizzle migrator will not execute; export `jsonb` from `@guren/orm/drizzle`.
  - **@guren/inertia-client**: add missing `./typed-forms` and `./components` export map entries (imports failed to resolve in published apps).
  - **create-guren-app**: `--auth` now runs after dependency installation using the app-local CLI and reports failures honestly (previously it always failed silently when run via bunx, yet printed a success message).
  - Docs: quick start now pins `create-guren-app@rc` (npm `latest` still points at the old 0.2.0 alpha) and reflects the SQLite default.

- 38bd637: Ensure dev asset server resolves and serves Inertia client chunks so the scaffold works in dev.
- da8707f: The release build runs build:create-app so the CLI binary is bundled.
- afe4bfd: Two fixes surfaced by dogfooding i18n in a real app:

  - **CSRF cookie refresh no longer wipes other cookies.** `setXsrfCookie` replaced the `Set-Cookie` header on the finalized response, silently dropping any cookie appended by inner middleware or handlers (e.g. a `locale` cookie). It now appends.
  - **`I18nConfig` accepts a `loader` option** as the i18n guide documents. Previously only `path` existed, so `MemoryLoader` (or any custom `TranslationLoader`) could not be injected into `createI18n` / `new I18nManager()`. `loader` takes precedence over `path`.

- 08ac277: Updated the scaffolded app template so new projects pull in the freshly published prerelease.
- 4011200: Second round of real-app (Kadai) fixes:

  - **@guren/cli codegen: inherited page props are no longer dropped.** `interface Props extends PaginatedPageProps<T> { ... }` now extracts as an intersection of the heritage clauses and the body. Previously only the body was captured — an empty-bodied extends silently degraded the page contract to `{}` (no type checking at all), and adding any own member made the inherited members vanish from the contract, rejecting valid controller props.
  - **@guren/testing: `TestApp.withCsrf()`** primes CSRF like a real browser — GETs a page, captures the session and XSRF-TOKEN cookies, and sends them (plus `X-XSRF-TOKEN`) on subsequent requests, so mutating endpoints are finally testable against apps with CSRF enabled.
  - **@guren/orm: `GUREN_QUIET_DUPLICATE_ORM=1`** silences the duplicate-copy warning for environments where two copies coexist by design (e.g. monorepo dev with src + dist).

- d8c572a: Fix the project created with the `create-guren-app` command so it can start successfully.
- 8ee89bb: Quality hardening: database-matrix runtime gates, upgrade-path protection, and add-on runtime smokes:

  - **PostgreSQL golden-path gate**: the scaffold→auth→CRUD runtime smoke now also runs against PostgreSQL in CI and the release workflow (dedicated `guren_smoke` database locally so developer data is never touched), verifying dialect-aware scaffolds, `resetDatabase()`, and `migrationStatus()` on pg for every release.
  - **`guren upgrade` works for the rc channel**: previously only `--canary` was supported, leaving rc users with no tool-assisted upgrade. `guren upgrade` now aligns every `@guren/*` package to a resolved dist-tag version (default `rc`, override with `--tag`), and warns when nested duplicate `@guren` copies survive in node_modules with the exact dedupe command.
  - **Duplicate-copy runtime guard**: loading two copies of `@guren/orm` (mixed versions) now prints a loud diagnostic explaining why database access fails and how to fix it, instead of failing silently with "database has not been configured".
  - **`Mail#build()` runs automatically**: scaffolded mailables previously threw "Email must have a subject" because `send()`/`queue()` never invoked `build()` — every user following the `add mail` scaffold hit this. Found by the new add-on runtime smoke, which now dispatches the scaffolded queue job and sends the scaffolded mailable on every release.

- 3add058: Fixed registerDevAssets to resolve the bundled Inertia client via @guren/inertia-client/app, rebuilt @guren/server, and confirmed the scaffolded app now loads without blank-screen 404s.
- 7f52ba4: Add open-source metadata, licensing, and community docs to prepare the packages for an initial public release.
- bba40d6: Runtime release gate, unified drizzle-kit migrations, and richer relations:

  - **Golden-path runtime smoke**: the release workflow now boots a scaffolded app and drives login, CRUD, CSRF, and auth rejection over HTTP before publishing — the class of published-artifact-only breakage fixed in rc.20 can no longer ship.
  - **Migrations unified on drizzle-kit**: `createSqliteDatabase`/`createPostgresDatabase`/`createMySqlDatabase` now expose `resetDatabase()` and `migrationStatus()`, making `guren db:reset`, `db:fresh`, and `db:status` work out of the box (all three previously failed on scaffolded apps). `db:rollback` now explains that drizzle-kit migrations are forward-only and points to `db:reset` or a compensating forward migration; the dead flat-SQL rollback tracker was removed.
  - **Relations**: nested eager loading with dot notation (`User.with('posts.comments')` — previously documented but not implemented) and `withCount()` (`users[0].postsCount`) for hasMany/hasOne/belongsTo/morphMany. Relation declarations no longer need `typeof` guards or `as any` casts; the testing mocks now include relation registrars so model modules load cleanly under Vitest.
  - Templates export `resetDatabase`/`migrationStatus` from config/database.ts and ship `db:reset`/`db:status` scripts; relationship docs updated (EN/JA) with the clean declaration pattern and `withCount`.

- 11e876c: first release
- Updated dependencies [c2f318d]
- Updated dependencies [e74eab5]
- Updated dependencies [b3c9414]
- Updated dependencies [73d311c]
- Updated dependencies [7687a0f]
- Updated dependencies [5fbd7e7]
- Updated dependencies [83ca2c2]
- Updated dependencies [38bd637]
- Updated dependencies [d3a0d2c]
- Updated dependencies [379d57e]
- Updated dependencies [c2f318d]
- Updated dependencies [da8707f]
- Updated dependencies [afe4bfd]
- Updated dependencies [57f6f35]
- Updated dependencies [77049eb]
- Updated dependencies [7fbf1de]
- Updated dependencies [08ac277]
- Updated dependencies [c10691c]
- Updated dependencies [a1fc6ec]
- Updated dependencies [f7de890]
- Updated dependencies [4011200]
- Updated dependencies [d8c572a]
- Updated dependencies [8ee89bb]
- Updated dependencies [3add058]
- Updated dependencies [7f52ba4]
- Updated dependencies [bba40d6]
- Updated dependencies [a835522]
- Updated dependencies [42c6053]
- Updated dependencies [ac73182]
- Updated dependencies [11e876c]
- Updated dependencies [73d311c]
  - @guren/inertia-client@1.0.0
  - @guren/orm@1.0.0

## 1.0.0-rc.26

### Minor Changes

- f7de890: Final API freeze pass before 1.0, driven by an adversarial pre-release review:

  - **`QueryBuilder.update()` now enforces the fillable allowlist** exactly like `Model.update()` (it previously bypassed mass-assignment protection entirely); `QueryBuilder.forceUpdate()` is the trusted-data escape hatch.
  - **Redis stores are now importable**: `@guren/core/redis` (and `@guren/server/redis`) ship `RedisSessionStore`, `RedisRateLimitStore`, `RedisSlidingWindowRateLimitStore`, `RedisApiTokenStore`, `RedisPasswordResetStore`, `RedisEmailVerificationStore`, and the new `RedisOAuthStateStore`. The default `MemoryOAuthStateStore` is now bounded (10k entries with expiry sweep) to prevent memory-exhaustion DoS.
  - **`PaginationMeta` name collision resolved**: the ORM's pagination meta is now `ModelPaginationMeta`; `PaginationMeta` from `@guren/core` unambiguously refers to the resource/paginator shape.
  - **React is a peer dependency**: `@guren/inertia-client` moves `react`/`react-dom` to peerDependencies, and `@guren/server` makes `@guren/inertia-client` an optional peer — API-only apps no longer pull React transitively.
  - **`@guren/testing/vitest` subpath**: vitest/React helpers move out of the root barrel so `bun:test` users don't need the React test stack; the related peer deps are marked optional.
  - **`Hash` is runtime-safe**: it now points at `DefaultHasher`, which delegates to Bun's scrypt on Bun and the Node implementation elsewhere (Lambda on Node no longer crashes).
  - Smaller freeze items: `ApplicationOptions`/`AuthPluginOptions` exported, unimplemented `Command.callSilent()` removed, `FormRequest` marked `@deprecated`, `MemoryQueueDriver`/`SyncQueueDriver`/`RedisQueueDriver` aliases added, internal ORM plumbing removed from the `@guren/core` allowlist, `nodemailer` bumped to v9 (HIGH advisory), stray `./dist/*` export wildcard removed.
  - **Docs**: broadcasting client flow rewritten around the `connected` handshake and `clientId` subscription (the previous example authorized but never subscribed), array-style query params documented, rc → 1.0.0 migration notes added, MySQL support matrix corrected, rate-limiting/serverless guides point at the shipped Redis stores.

### Patch Changes

- Updated dependencies [f7de890]
  - @guren/orm@1.0.0-rc.27
  - @guren/inertia-client@1.0.0-rc.25

## 1.0.0-rc.25

### Minor Changes

- a1fc6ec: Two security defaults locked in ahead of 1.0:

  - **Strict mass assignment.** When a model defines `fillable`, `create()`/`update()` now throw a `MassAssignmentException` naming any field outside the allowlist instead of silently discarding it (silent drops surfaced as NOT NULL violations far from the cause, and masked injection attempts). Use the new `forceCreate()` / `forceUpdate()` for trusted server-side data, or set `static strictFillable = false` per model to restore the old behavior. The `guarded` path is unchanged.
  - **`auth.user()` never exposes credentials.** The session guard sanitizes user records before caching or returning them: the password column, remember-token column, and the model's `static hidden` fields are stripped. Credential checks still run on the raw record internally, so login and remember-me behave exactly as before — but sharing `auth.user` into Inertia props no longer leaks `passwordHash` to the browser. Custom user providers can opt in via the new optional `UserProvider.sanitize()`. `guren add auth` now generates the User model with `static hidden = ['passwordHash', 'rememberToken']`.

### Patch Changes

- Updated dependencies [a1fc6ec]
  - @guren/orm@1.0.0-rc.26
  - @guren/inertia-client@1.0.0-rc.24

## 1.0.0-rc.24

### Minor Changes

- c10691c: Three bug fixes ahead of 1.0:

  - **Nested eager loading now works at any depth** (#15). `User.with('posts.comments.author')` previously loaded two levels and silently left deeper relations unloaded when going through the query builder. `QueryBuilder` now delegates the full dotted path to `Model.loadRelationInto`, which recurses correctly.
  - **Auth context is available to middleware registered before `boot()`** (#13). The fallback auth context (apps without `options.auth`) is attached in the `Application` constructor, and the context resolves its session lazily — so `app.use(requireAuthenticated())` before `boot()` responds 401 instead of throwing, regardless of session middleware ordering.
  - **Route contracts accept array-style query strings** (#12). `?tag=a&tag=b` now reaches query schemas as `{ tag: ['a', 'b'] }` (single occurrences stay plain strings), matching the controller-side `validateQuery` behavior. Schemas that expect a plain string for a key clients may repeat should switch to `z.array(...)` or accept both.
  - **`guren add oauth` now generates code that compiles.** The scaffolded controller named its action `redirect`, shadowing the base `Controller.redirect()` helper (infinite recursion) and failing to typecheck; the route-param validator also rejected `string | undefined`. The action is now `redirectToProvider` and the validator handles missing params.

### Patch Changes

- Updated dependencies [c10691c]
  - @guren/orm@1.0.0-rc.25
  - @guren/inertia-client@1.0.0-rc.23

## 1.0.0-rc.23

### Minor Changes

- d3a0d2c: DX fixes from the i18n dogfooding lap:

  - **Middleware `c.header()` now reaches controller responses.** Handlers and controllers return raw `Response` objects, which bypassed Hono's response construction — headers staged via `c.header()` in upstream middleware (e.g. a locale cookie) were silently dropped. Route responses are now rebuilt through `c.newResponse()`, merging prepared headers (`Set-Cookie` appended, the handler's own headers winning otherwise).
  - **`TestApp.withHeaders()` / `withHeader()`**: send custom request headers on every request (Accept-Language, bearer tokens, …). Like `actingAs()` and `json()`, they return a new `TestApp` and compose freely.
  - **`shareInertiaProps()`** merges shared props over previously registered resolvers, so multiple providers can each contribute (auth, i18n, flash, …) without clobbering one another. `getInertiaSharedPropsResolver()` is now exported for manual composition.
  - **Docs**: global middleware must be attached in a provider's `register()` — routes mount before `boot()`, so `app.use()` from `boot()` never applies. Documented in the architecture guide (en/ja).

### Patch Changes

- Updated dependencies [d3a0d2c]
  - @guren/orm@1.0.0-rc.24
  - @guren/inertia-client@1.0.0-rc.22

## 1.0.0-rc.22

### Minor Changes

- 7fbf1de: Accept Hono middleware as a terminal route handler:

  - **`RouteHandler` now includes `(c, next)` signatures**, so any Hono `MiddlewareHandler` — including `broadcast.sseMiddleware()` and `broadcast.authMiddleware()` — can be passed directly to `router.get()` / `router.post()` as the docs show, without wrapper closures or `as Promise<Response>` casts.
  - **Responses set via `c.res` are honored**: a middleware mounted as a handler that finalizes the response through `next()` or `c.res =` no longer gets clobbered by a synthesized `204 No Content`. Plain handlers returning `undefined` still produce `204`.

### Patch Changes

- afe4bfd: Two fixes surfaced by dogfooding i18n in a real app:

  - **CSRF cookie refresh no longer wipes other cookies.** `setXsrfCookie` replaced the `Set-Cookie` header on the finalized response, silently dropping any cookie appended by inner middleware or handlers (e.g. a `locale` cookie). It now appends.
  - **`I18nConfig` accepts a `loader` option** as the i18n guide documents. Previously only `path` existed, so `MemoryLoader` (or any custom `TranslationLoader`) could not be injected into `createI18n` / `new I18nManager()`. `loader` takes precedence over `path`.

- Updated dependencies [afe4bfd]
- Updated dependencies [7fbf1de]
  - @guren/orm@1.0.0-rc.23
  - @guren/inertia-client@1.0.0-rc.21

## 1.0.0-rc.21

### Minor Changes

- 42c6053: Make SSE broadcasting actually reachable from clients:

  - **The SSE stream announces the connection** with a `connected` event carrying the `clientId` and any already-subscribed channels. Previously clients had no way to learn their id, and no HTTP path ever subscribed a client to a channel — SSE connections received pings but never a single broadcast event.
  - **`?channels=a,b` query subscriptions** on the SSE endpoint: requested channels are authorized against the connecting user (`sseMiddleware({ getUser })`) and subscribed before the stream starts, so a bare `EventSource` works for public channels.
  - **`POST /broadcasting/auth` subscribes as well as authorizes** when the payload includes the `clientId`, returning `{ authorized, subscribed }` per channel.
  - **Unregistered `private-`/`presence-` channels now default to deny** instead of public access — a missing channel registration no longer silently exposes a private channel.

### Patch Changes

- Updated dependencies [42c6053]
  - @guren/orm@1.0.0-rc.22
  - @guren/inertia-client@1.0.0-rc.20

## 1.0.0-rc.20

### Minor Changes

- 379d57e: First-class file uploads:

  - **`this.file(name)` / `this.files(name)` controller helpers** — read uploaded files from multipart requests (null/empty-safe, composes with other body reads via Hono's cached parseBody). Previously controllers had to call `this.request.parseBody()` and duck-type the result.
  - **`TestApp` accepts `FormData` bodies** — `csrf.post('/tasks/1/attachments', formData)` sends real multipart requests, so upload endpoints are finally testable.

### Patch Changes

- Updated dependencies [379d57e]
  - @guren/orm@1.0.0-rc.21
  - @guren/inertia-client@1.0.0-rc.19

## 1.0.0-rc.19

### Patch Changes

- 4011200: Second round of real-app (Kadai) fixes:

  - **@guren/cli codegen: inherited page props are no longer dropped.** `interface Props extends PaginatedPageProps<T> { ... }` now extracts as an intersection of the heritage clauses and the body. Previously only the body was captured — an empty-bodied extends silently degraded the page contract to `{}` (no type checking at all), and adding any own member made the inherited members vanish from the contract, rejecting valid controller props.
  - **@guren/testing: `TestApp.withCsrf()`** primes CSRF like a real browser — GETs a page, captures the session and XSRF-TOKEN cookies, and sends them (plus `X-XSRF-TOKEN`) on subsequent requests, so mutating endpoints are finally testable against apps with CSRF enabled.
  - **@guren/orm: `GUREN_QUIET_DUPLICATE_ORM=1`** silences the duplicate-copy warning for environments where two copies coexist by design (e.g. monorepo dev with src + dist).

- Updated dependencies [4011200]
  - @guren/orm@1.0.0-rc.20
  - @guren/inertia-client@1.0.0-rc.18

## 1.0.0-rc.18

### Minor Changes

- 57f6f35: Fixes and features from building a real app (Kadai) on the published packages:

  - **@guren/server: entry bundles now share chunks** (tsup `splitting: true`). Each entry point previously bundled its own copy of module-level state, so `registerJob()` via the root entry and `Worker` via `./queue` used different job registries — jobs failed with "Job class not found". The same duplication affected the mail manager and queue driver globals.
  - **@guren/server: new `SyncDriver` (queue) and `LogTransport` (mail)** — the template `.env` defaults (`QUEUE_CONNECTION=sync`, `MAIL_MAILER=log`) previously named drivers that did not exist. Sync dispatch executes jobs inline with no worker process; the log transport writes full messages to server output. The `add queue` / `add mail` blueprints now honor these env vars and default to sync/log.
  - **@guren/orm: multi-relation type fix** — `findWith(id, ['a', 'b'])` and `with(['a', 'b'])` typed their results as a union of single-relation picks instead of an intersection, making relation properties inaccessible.
  - **@guren/orm: `QueryBuilder.paginate()` accepts an options object** (`{ page, perPage }`) in addition to positional arguments, matching `Model.paginate()`.

### Patch Changes

- Updated dependencies [57f6f35]
  - @guren/orm@1.0.0-rc.19
  - @guren/inertia-client@1.0.0-rc.17

## 1.0.0-rc.17

### Patch Changes

- 8ee89bb: Quality hardening: database-matrix runtime gates, upgrade-path protection, and add-on runtime smokes:

  - **PostgreSQL golden-path gate**: the scaffold→auth→CRUD runtime smoke now also runs against PostgreSQL in CI and the release workflow (dedicated `guren_smoke` database locally so developer data is never touched), verifying dialect-aware scaffolds, `resetDatabase()`, and `migrationStatus()` on pg for every release.
  - **`guren upgrade` works for the rc channel**: previously only `--canary` was supported, leaving rc users with no tool-assisted upgrade. `guren upgrade` now aligns every `@guren/*` package to a resolved dist-tag version (default `rc`, override with `--tag`), and warns when nested duplicate `@guren` copies survive in node_modules with the exact dedupe command.
  - **Duplicate-copy runtime guard**: loading two copies of `@guren/orm` (mixed versions) now prints a loud diagnostic explaining why database access fails and how to fix it, instead of failing silently with "database has not been configured".
  - **`Mail#build()` runs automatically**: scaffolded mailables previously threw "Email must have a subject" because `send()`/`queue()` never invoked `build()` — every user following the `add mail` scaffold hit this. Found by the new add-on runtime smoke, which now dispatches the scaffolded queue job and sends the scaffolded mailable on every release.

- Updated dependencies [8ee89bb]
  - @guren/orm@1.0.0-rc.17
  - @guren/inertia-client@1.0.0-rc.16

## 1.0.0-rc.16

### Patch Changes

- bba40d6: Runtime release gate, unified drizzle-kit migrations, and richer relations:

  - **Golden-path runtime smoke**: the release workflow now boots a scaffolded app and drives login, CRUD, CSRF, and auth rejection over HTTP before publishing — the class of published-artifact-only breakage fixed in rc.20 can no longer ship.
  - **Migrations unified on drizzle-kit**: `createSqliteDatabase`/`createPostgresDatabase`/`createMySqlDatabase` now expose `resetDatabase()` and `migrationStatus()`, making `guren db:reset`, `db:fresh`, and `db:status` work out of the box (all three previously failed on scaffolded apps). `db:rollback` now explains that drizzle-kit migrations are forward-only and points to `db:reset` or a compensating forward migration; the dead flat-SQL rollback tracker was removed.
  - **Relations**: nested eager loading with dot notation (`User.with('posts.comments')` — previously documented but not implemented) and `withCount()` (`users[0].postsCount`) for hasMany/hasOne/belongsTo/morphMany. Relation declarations no longer need `typeof` guards or `as any` casts; the testing mocks now include relation registrars so model modules load cleanly under Vitest.
  - Templates export `resetDatabase`/`migrationStatus` from config/database.ts and ship `db:reset`/`db:status` scripts; relationship docs updated (EN/JA) with the clean declaration pattern and `withCount`.

- Updated dependencies [bba40d6]
  - @guren/orm@1.0.0-rc.15
  - @guren/inertia-client@1.0.0-rc.15

## 1.0.0-rc.15

### Patch Changes

- 83ca2c2: Fix critical scaffold-to-runtime breakages found by dogfooding the published packages:

  - **@guren/server**: stop bundling `@guren/orm` (now a real dependency). The bundled copy created a second `Model`/`DrizzleAdapter` instance, so `configureOrm()` never reached `AuthenticatableModel` and every auth query failed with "database has not been configured" in published apps.
  - **@guren/cli `add auth`**: schema updates and the users migration now respect the app's database dialect (sqlite/postgres/mysql) instead of always emitting Postgres SQL; the migration is generated via drizzle-kit instead of a loose `.sql` file that `db:migrate` never executed; `createApp()` is patched with `auth: {}` so sessions and CSRF actually mount.
  - **@guren/cli `add resource`**: honors `--fields` (previously silently ignored) and adds `--public`; delegates file generation to the `make:feature` templates; registers the route group with typed body contracts — the previous insertion regex never matched the starter template, so routes were silently never registered.
  - **@guren/cli `codegen`**: generates route/data/channel/API-client artifacts by default (previously skipped silently unless `--routes` was passed, leaving `routes.gen.ts` empty).
  - **@guren/orm**: warn when the migrations folder contains loose `.sql` files that the drizzle migrator will not execute; export `jsonb` from `@guren/orm/drizzle`.
  - **@guren/inertia-client**: add missing `./typed-forms` and `./components` export map entries (imports failed to resolve in published apps).
  - **create-guren-app**: `--auth` now runs after dependency installation using the app-local CLI and reports failures honestly (previously it always failed silently when run via bunx, yet printed a success message).
  - Docs: quick start now pins `create-guren-app@rc` (npm `latest` still points at the old 0.2.0 alpha) and reflects the SQLite default.

- Updated dependencies [83ca2c2]
  - @guren/orm@1.0.0-rc.14
  - @guren/inertia-client@1.0.0-rc.14

## 1.0.0-rc.14

### Minor Changes

- Secure-by-default hardening and AI-agent tooling:

  - `guren audit` command: validates auth/validation coverage on mutating routes, detects raw SQL, secrets, and mass assignment risks
  - `make:feature` now scaffolds auth checks by default (`--public` to opt out) and supports `--policy`
  - Authorization gate wiring, hardened auth/storage/mail/error rendering
  - Inertia asset version mismatch handling
  - drizzle-orm / drizzle-kit upgraded to 1.0.0-rc.1
  - Migration tracker SQL escaping fix and dependency vulnerability patches

### Patch Changes

- Updated dependencies
  - @guren/inertia-client@1.0.0-rc.13

## 1.0.0-rc.13

### Patch Changes

- feat(cli): add @guren/plugin-vercel and remove legacy deploy vercel target
  fix(create-app,orm,cli): fix blog blueprint SQLite support and DX issues
  fix(create-app): comment out VITE_DEV_SERVER_URL in template .env
- Updated dependencies
  - @guren/inertia-client@1.0.0-rc.12

## 1.0.0-rc.12

### Patch Changes

- fix(server): use figlet importable-fonts for bundled builds

## 1.0.0-rc.11

### Patch Changes

- fix(ci): upgrade to Node 24 for npm OIDC trusted publishing
- Updated dependencies
  - @guren/inertia-client@1.0.0-rc.11

## 1.0.0-rc.10

### Patch Changes

- Align all packages to rc.10.
- Updated dependencies
  - @guren/inertia-client@1.0.0-rc.10

## 1.0.0-rc.9

### Patch Changes

- Align all packages to rc.9.
- Updated dependencies
  - @guren/inertia-client@1.0.0-rc.9

## 1.0.0-rc.8

### Major Changes

- v1.0 Release Candidate

  New subsystems: OAuth, MySQL adapter, typed broadcasting, OpenAPI generation,
  production error pages, request ID/logging middleware, plugin test harness,
  API-only and worker starter kits.

  DX: Golden path standardization, doctor autofixes, CLI consistency,
  upgrade productization, security defaults.

  Quality: Playwright E2E, CI matrix, nightly canary, benchmarks,
  smoke tests for all starter kits.

  Docs: Task-completion guides (en/ja), plugin authoring guide,
  deployment recipes (Docker, Fly.io, VPS, serverless).

  Governance: API stability tiers, deprecation policy, SemVer guidance,
  RFC process, release cadence, issue triage SLAs.

### Patch Changes

- Updated dependencies
  - @guren/inertia-client@1.0.0-rc.8

## 0.2.0-alpha.7

### Patch Changes

- Fix the project created with the `create-guren-app` command so it can start successfully.
- Updated dependencies
  - @guren/inertia-client@0.2.0-alpha.7

## 0.2.0-alpha.6

### Minor Changes

- Added SSR support, ORM relationships, pagination, and authentication enhancements.

### Patch Changes

- Updated dependencies
  - @guren/inertia-client@0.2.0-alpha.6

## 0.1.1-alpha.5

### Patch Changes

- Ensure dev asset server resolves and serves Inertia client chunks so the scaffold works in dev.
- Updated dependencies
  - @guren/inertia-client@0.1.1-alpha.5

## 0.1.1-alpha.4

### Patch Changes

- Fixed registerDevAssets to resolve the bundled Inertia client via @guren/inertia-client/app, rebuilt @guren/server, and confirmed the scaffolded app now loads without blank-screen 404s.
- Updated dependencies
  - @guren/inertia-client@0.1.1-alpha.4

## 0.1.1-alpha.3

### Patch Changes

- The release build runs build:create-app so the CLI binary is bundled.
- Updated dependencies
  - @guren/inertia-client@0.1.1-alpha.3

## 0.1.1-alpha.2

### Patch Changes

- Updated the scaffolded app template so new projects pull in the freshly published prerelease.
- Updated dependencies
  - @guren/inertia-client@0.1.1-alpha.2

## 0.1.1-alpha.1

### Patch Changes

- Pinned dependencies to specific versions for consistency across packages
- Updated dependencies
  - @guren/inertia-client@0.1.1-alpha.1

## 0.1.1-alpha.0

### Patch Changes

- 7f52ba4: Add open-source metadata, licensing, and community docs to prepare the packages for an initial public release.
- first release
- Updated dependencies [7f52ba4]
- Updated dependencies
  - @guren/inertia-client@0.1.1-alpha.0
