# @guren/openapi

## 1.3.1

### Patch Changes

- 8871c4c: Build with tsdown instead of tsup, and emit declarations with the native TypeScript 7 compiler. The public file layout of every package is unchanged (same `dist/*.js` / `dist/*.d.ts` entry names, shebangs, and `exports`); only the internal chunk names differ. tsup is unmaintained and its declaration bundler needs the JavaScript compiler API that TypeScript 7 no longer ships.
- Updated dependencies [deaa5c0]
- Updated dependencies [8871c4c]
  - @guren/core@1.8.1

## 1.3.0

### Minor Changes

- 0e615fc: First-class support for the HTTP QUERY method (RFC 10008)

  QUERY is safe and idempotent like GET but carries a request body like POST — the right verb for search and filter endpoints whose criteria don't fit in a URL.

  - `router.query(path, options, handler)` registers QUERY routes with the same overloads as the other verbs, on the router and inside `middleware(...)` group builders (which also gain the generic `on()` for arbitrary methods).

  ```ts
  router.query(
    "/posts/search",
    {
      name: "posts.search",
      body: z.object({ keywords: z.array(z.string()) }),
    },
    [PostsController, "search"]
  );
  ```

  - `TestApp.query(path, body?)` drives QUERY routes in tests.
  - Codegen picks QUERY routes up automatically; the generated API client sends them with a body (`client.request('posts.search', { body })`).
  - CSRF protection deliberately skips QUERY by default: it is a safe method, and browsers cannot send it without a CORS preflight. Keep QUERY handlers read-only, or opt into protection via the middleware's `methods` option — the generated client keeps sending the XSRF header on same-origin browser requests, so that opt-in works there (cross-origin clients supply their own header, as with every method).
  - `guren audit` checks body validation on QUERY routes without demanding auth middleware on them, matching GET.
  - The OpenAPI generator now allowlists the methods OpenAPI 3.1 can express and skips others (QUERY included) with a warning — previously a QUERY route would silently produce an invalid document. Mounted docs surface those warnings once via `console.warn`.

  Also fixed: `createCorsMiddleware` used to hand Hono an explicit `allowMethods: undefined`, which erased Hono's default and made every preflight answer without an `Access-Control-Allow-Methods` header. Guren now owns the default list (GET, HEAD, PUT, POST, DELETE, PATCH, QUERY).

  Deployment note: Guren's fetch-based adapters (Bun, the Cloudflare Workers and Vercel plugins) do not block QUERY, but verify your platform's ingress accepts the method — CloudFront, which fronts the app in the Lambda plugin's asset setup, does not forward it.

### Patch Changes

- Updated dependencies [0e615fc]
  - @guren/core@1.6.0

## 1.2.0

### Minor Changes

- 452e187: Accept a function for the `servers` option, resolved every time a document is generated

  A mounted document is rendered per request, but `servers` could only be given as a fixed list — so an app could advertise no address it did not already know when the module ran. With `PORT=0` the OS assigns the port during `listen()`, leaving the document pointing generated clients and the Scalar "try it" button at a port nothing is listening on.

  `servers` now also accepts `() => Array<string | OpenApiServer>`, called once per generated document:

  ```ts
  let serverUrl = "http://localhost:3334";

  mountOpenApiDocs(app, {
    title: "Example API",
    version: "1.0.0",
    servers: () => [serverUrl],
  });

  const address = await app.listen({ port: 0 });
  serverUrl = address.url;
  ```

  Passing an array behaves exactly as before.

## 1.1.0

### Minor Changes

- 1bccf80: feat: the schema walkers read the zod 4 API only, and refuse zod 3 loudly

  The TypeScript-type renderer (`guren codegen`, `guren context`) and the OpenAPI
  generator previously walked both Zod majors. The two dialects disagree about
  the meaning of `_def.type` — v3 stores a nested schema there, v4 the type
  name — and that ambiguity is what produced the walker bugs that had to be
  fixed twice. Since every Guren scaffold has always pinned zod 4, the walkers
  now read the v4 layout exclusively.

  A schema authored with the zod v3 API — whether from the old `zod@3` package
  or the `zod/v3` subpath that zod 4 itself ships — is detected (only v3 sets
  `_def.typeName`) and refused with an explicit message instead of being
  rendered wrong or silently dropped: the CLI warns once per process, the
  OpenAPI document records a warning naming the schema's location. The message
  lives in `@guren/core/internal/zod-compat` as `ZOD3_UNSUPPORTED_MESSAGE`, so
  the two surfaces cannot drift apart. Detection runs on every node, not just
  at the walk's entry — a v3 node nested inside a v4 object (which nothing but
  the type system prevents) is refused too, and the OpenAPI request-body
  `required` probe survives the `safeParse` throw such a hybrid produces in
  zod 4 rather than crashing document generation.

  Dropping the v3 dialect also deletes code that was unreachable under v4:
  the `pipeline`, `discriminatedunion`, and `nativeenum` case labels (v4 names
  them `pipe`, `union`, and `enum`), the `effects` and `branded` wrapper names
  (v4 has no such nodes — `.brand()` adds nothing at runtime), and the
  function-shaped `_def.shape` read.

  Two behavior improvements ride along, both in enum handling (`z.nativeEnum`
  produces the same node as `z.enum` in zod 4). Documented values are now read
  from zod's own computed set (`_zod.values`) instead of re-derived from the
  entries object, so what the document lists is what zod parses by
  construction: reverse mappings of a numeric TypeScript enum (`{ A: 0,
'0': 'A' }`) no longer leak into the OpenAPI `enum` list, and the derivation
  has no false positives — a hand-rolled reverse-mapping filter would wrongly
  drop a member whose string value collides with another key (`{ A: 'B',
B: 1 }`). A mixed string/number enum also documents as
  `type: ['string', 'number']` rather than `number`. The `zod/v3` subpath was
  never used by any Guren template, example, or generated app.

### Patch Changes

- 8567233: Keep array element types, Zod 3 pipelines, and response-side types in the
  generated OpenAPI document.

  Every array rendered as `items: {}`. Zod 4 keeps an array's element in
  `_def.element` and puts the literal string `'array'` in `_def.type`, and the
  walker read `_def.type` first — so it handed that string back to itself,
  failed to recognize it as a schema, and fell back to an empty item schema.
  Zod 3 stores the element in `_def.type`, so both orderings have to be tried,
  with `element` first.

  Zod 3 names a pipe `ZodPipeline`, which the walker did not recognize at all:
  a `.pipe()`ed property was dropped from the document rather than mis-typed.
  Zod 4's `prefault()` and `nonoptional()` were dropped the same way, as was a
  Zod 3 `.brand()`, which keeps its inner schema under a key the walker read as
  a type name.

  Request and response schemas are now walked in their own direction. A pipe
  carries a separate type per side, so a `z.string().pipe(z.coerce.number())`
  response documented the string a caller sends instead of the number it
  receives; a `.transform()` has no readable output type, so its input side
  stays the answer for both. A `.default()`ed field is likewise omittable from
  a request but always present in a response, and now appears in the response's
  `required` list.

  A `query` or `params` schema wrapped in `.default()`, `.optional()`,
  `.catch()` or `.nullable()` lost every one of its parameters, because the walk
  that finds the object behind a parameter schema looked through a shorter list
  of wrappers than the two walks that render types and decide presence. All
  three now read one shared set, so a wrapper cannot reach one walk and miss
  another.

  Two more properties were described as required when they are not, and one
  the reverse. A `.catch()`ed field substitutes its fallback for any failure, a
  missing value included, so a request never has to carry it. A `.pipe()`d field
  runs both stages, so it may be omitted only when neither stage rejects a
  missing value — reading just the side being documented promised an omission
  the other stage refuses.

  A `z.lazy()` schema keeps its contents behind a getter this walker does not
  call, so the property cannot be documented. It is now reported as a warning
  instead of vanishing, along with any other wrapper whose contents cannot be
  read — a silently missing property reads as a schema that never declared one.

  Coercion is deliberately not widened: OpenAPI describes JSON in both
  directions, so `z.coerce.date()` already documents as the ISO string a caller
  sends, and widening `z.coerce.number()` to accept a string would cost callers
  precision in exchange for nothing the schema requires.

- 460e0e2: refactor: share the Zod v3/v4 compatibility primitives between the two schema walkers

  `@guren/cli`'s TypeScript-type renderer and `@guren/openapi`'s schema-object
  renderer each carried their own copy of the knowledge needed to read a Zod
  schema without caring which major produced it: type-name lookup, the `Zod`
  prefix normalization, wrapper unwrapping, pipe-side selection, object-shape
  reading, and enum/literal value extraction. Knowledge added to one never
  reached the other — a Zod 4 array keeps its element in `_def.element` while
  `_def.type` holds the string `'array'`, and reading them in the wrong order
  silently dropped the element type. That single bug had to be found and fixed
  twice, months apart, once per package.

  Those primitives now live in `@guren/core/internal/zod-compat`, a deep-import
  internal module in the same vein as `internal/deploy-build`. Both walkers read
  from it, so a version quirk learned once is known in both places.

  The set of type names that carry exactly one nested schema moves too, as
  `SINGLE_CHILD_WRAPPERS` plus the two partitions each walker needs. The walkers
  had looked like they disagreed here — one held a five-name set, the other a
  twelve-name one — but the CLI simply handled the other seven as explicit
  `switch` cases. They differ in how they partition the vocabulary, not in what
  is in it, so the membership is now stated once.

  The type switches themselves stay where they are: one produces TypeScript type
  strings, the other OpenAPI schema objects. Their leaf vocabularies have
  legitimately diverged (the CLI renders `void`/`any`/`never`, which OpenAPI
  cannot express), and that is a rendering decision rather than version
  knowledge.

  Both `isOptional`s also stay with their callers, but not because each is right
  for its own purpose — the CLI reads one side of a `.pipe()` and the OpenAPI
  walker requires both, and each can be fooled by a pipeline the other handles.
  Deciding omissibility correctly means simulating a parse, which is a separate
  piece of work; the two approximations are now labelled as such where they live.

  Three incidental hardenings come along for the ride. The CLI's inner-schema
  lookup now skips non-object candidates instead of taking the first non-nullish
  one; a nested node with no readable type name renders as `unknown` rather than
  throwing; and two degenerate schemas that used to emit invalid TypeScript now
  render correctly — an empty `z.enum([])` as `never` instead of an empty string,
  and `z.literal(undefined)` as `undefined` rather than being dropped by
  `JSON.stringify`.

- Updated dependencies [fe0c13d]
- Updated dependencies [fe0c13d]
- Updated dependencies [e2c82da]
- Updated dependencies [460e0e2]
- Updated dependencies [1bccf80]
  - @guren/core@1.5.0

## 1.0.0

### Major Changes

- 73d311c: Promote OpenAPI package to v1.0 alongside other packages.

### Patch Changes

- c2f318d: Align all packages to rc.10.
- e74eab5: fix(ci): upgrade to Node 24 for npm OIDC trusted publishing
- dcee3ee: fix(server): use figlet importable-fonts for bundled builds
- b3c9414: feat(cli): add @guren/plugin-vercel and remove legacy deploy vercel target
  fix(create-app,orm,cli): fix blog blueprint SQLite support and DX issues
  fix(create-app): comment out VITE_DEV_SERVER_URL in template .env
- 83ca2c2: Fix critical scaffold-to-runtime breakages found by dogfooding the published packages:

  - **@guren/server**: stop bundling `@guren/orm` (now a real dependency). The bundled copy created a second `Model`/`DrizzleAdapter` instance, so `configureOrm()` never reached `AuthenticatableModel` and every auth query failed with "database has not been configured" in published apps.
  - **@guren/cli `add auth`**: schema updates and the users migration now respect the app's database dialect (sqlite/postgres/mysql) instead of always emitting Postgres SQL; the migration is generated via drizzle-kit instead of a loose `.sql` file that `db:migrate` never executed; `createApp()` is patched with `auth: {}` so sessions and CSRF actually mount.
  - **@guren/cli `add resource`**: honors `--fields` (previously silently ignored) and adds `--public`; delegates file generation to the `make:feature` templates; registers the route group with typed body contracts — the previous insertion regex never matched the starter template, so routes were silently never registered.
  - **@guren/cli `codegen`**: generates route/data/channel/API-client artifacts by default (previously skipped silently unless `--routes` was passed, leaving `routes.gen.ts` empty).
  - **@guren/orm**: warn when the migrations folder contains loose `.sql` files that the drizzle migrator will not execute; export `jsonb` from `@guren/orm/drizzle`.
  - **@guren/inertia-client**: add missing `./typed-forms` and `./components` export map entries (imports failed to resolve in published apps).
  - **create-guren-app**: `--auth` now runs after dependency installation using the app-local CLI and reports failures honestly (previously it always failed silently when run via bunx, yet printed a success message).
  - Docs: quick start now pins `create-guren-app@rc` (npm `latest` still points at the old 0.2.0 alpha) and reflects the SQLite default.

- d3a0d2c: DX fixes from the i18n dogfooding lap:

  - **Middleware `c.header()` now reaches controller responses.** Handlers and controllers return raw `Response` objects, which bypassed Hono's response construction — headers staged via `c.header()` in upstream middleware (e.g. a locale cookie) were silently dropped. Route responses are now rebuilt through `c.newResponse()`, merging prepared headers (`Set-Cookie` appended, the handler's own headers winning otherwise).
  - **`TestApp.withHeaders()` / `withHeader()`**: send custom request headers on every request (Accept-Language, bearer tokens, …). Like `actingAs()` and `json()`, they return a new `TestApp` and compose freely.
  - **`shareInertiaProps()`** merges shared props over previously registered resolvers, so multiple providers can each contribute (auth, i18n, flash, …) without clobbering one another. `getInertiaSharedPropsResolver()` is now exported for manual composition.
  - **Docs**: global middleware must be attached in a provider's `register()` — routes mount before `boot()`, so `app.use()` from `boot()` never applies. Documented in the architecture guide (en/ja).

- 379d57e: First-class file uploads:

  - **`this.file(name)` / `this.files(name)` controller helpers** — read uploaded files from multipart requests (null/empty-safe, composes with other body reads via Hono's cached parseBody). Previously controllers had to call `this.request.parseBody()` and duck-type the result.
  - **`TestApp` accepts `FormData` bodies** — `csrf.post('/tasks/1/attachments', formData)` sends real multipart requests, so upload endpoints are finally testable.

- afe4bfd: Two fixes surfaced by dogfooding i18n in a real app:

  - **CSRF cookie refresh no longer wipes other cookies.** `setXsrfCookie` replaced the `Set-Cookie` header on the finalized response, silently dropping any cookie appended by inner middleware or handlers (e.g. a `locale` cookie). It now appends.
  - **`I18nConfig` accepts a `loader` option** as the i18n guide documents. Previously only `path` existed, so `MemoryLoader` (or any custom `TranslationLoader`) could not be injected into `createI18n` / `new I18nManager()`. `loader` takes precedence over `path`.

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

- 4011200: Second round of real-app (Kadai) fixes:

  - **@guren/cli codegen: inherited page props are no longer dropped.** `interface Props extends PaginatedPageProps<T> { ... }` now extracts as an intersection of the heritage clauses and the body. Previously only the body was captured — an empty-bodied extends silently degraded the page contract to `{}` (no type checking at all), and adding any own member made the inherited members vanish from the contract, rejecting valid controller props.
  - **@guren/testing: `TestApp.withCsrf()`** primes CSRF like a real browser — GETs a page, captures the session and XSRF-TOKEN cookies, and sends them (plus `X-XSRF-TOKEN`) on subsequent requests, so mutating endpoints are finally testable against apps with CSRF enabled.
  - **@guren/orm: `GUREN_QUIET_DUPLICATE_ORM=1`** silences the duplicate-copy warning for environments where two copies coexist by design (e.g. monorepo dev with src + dist).

- 8ee89bb: Quality hardening: database-matrix runtime gates, upgrade-path protection, and add-on runtime smokes:

  - **PostgreSQL golden-path gate**: the scaffold→auth→CRUD runtime smoke now also runs against PostgreSQL in CI and the release workflow (dedicated `guren_smoke` database locally so developer data is never touched), verifying dialect-aware scaffolds, `resetDatabase()`, and `migrationStatus()` on pg for every release.
  - **`guren upgrade` works for the rc channel**: previously only `--canary` was supported, leaving rc users with no tool-assisted upgrade. `guren upgrade` now aligns every `@guren/*` package to a resolved dist-tag version (default `rc`, override with `--tag`), and warns when nested duplicate `@guren` copies survive in node_modules with the exact dedupe command.
  - **Duplicate-copy runtime guard**: loading two copies of `@guren/orm` (mixed versions) now prints a loud diagnostic explaining why database access fails and how to fix it, instead of failing silently with "database has not been configured".
  - **`Mail#build()` runs automatically**: scaffolded mailables previously threw "Email must have a subject" because `send()`/`queue()` never invoked `build()` — every user following the `add mail` scaffold hit this. Found by the new add-on runtime smoke, which now dispatches the scaffolded queue job and sends the scaffolded mailable on every release.

- bba40d6: Runtime release gate, unified drizzle-kit migrations, and richer relations:

  - **Golden-path runtime smoke**: the release workflow now boots a scaffolded app and drives login, CRUD, CSRF, and auth rejection over HTTP before publishing — the class of published-artifact-only breakage fixed in rc.20 can no longer ship.
  - **Migrations unified on drizzle-kit**: `createSqliteDatabase`/`createPostgresDatabase`/`createMySqlDatabase` now expose `resetDatabase()` and `migrationStatus()`, making `guren db:reset`, `db:fresh`, and `db:status` work out of the box (all three previously failed on scaffolded apps). `db:rollback` now explains that drizzle-kit migrations are forward-only and points to `db:reset` or a compensating forward migration; the dead flat-SQL rollback tracker was removed.
  - **Relations**: nested eager loading with dot notation (`User.with('posts.comments')` — previously documented but not implemented) and `withCount()` (`users[0].postsCount`) for hasMany/hasOne/belongsTo/morphMany. Relation declarations no longer need `typeof` guards or `as any` casts; the testing mocks now include relation registrars so model modules load cleanly under Vitest.
  - Templates export `resetDatabase`/`migrationStatus` from config/database.ts and ship `db:reset`/`db:status` scripts; relationship docs updated (EN/JA) with the clean declaration pattern and `withCount`.

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

- Updated dependencies [c2f318d]
- Updated dependencies [e74eab5]
- Updated dependencies [dcee3ee]
- Updated dependencies [b3c9414]
- Updated dependencies [73d311c]
- Updated dependencies [5fbd7e7]
- Updated dependencies [83ca2c2]
- Updated dependencies [38bd637]
- Updated dependencies [d3a0d2c]
- Updated dependencies [379d57e]
- Updated dependencies [da8707f]
- Updated dependencies [afe4bfd]
- Updated dependencies [57f6f35]
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
  - @guren/core@1.0.0

## 1.0.0-rc.26

### Patch Changes

- f7de890: Final API freeze pass before 1.0, driven by an adversarial pre-release review:

  - **`QueryBuilder.update()` now enforces the fillable allowlist** exactly like `Model.update()` (it previously bypassed mass-assignment protection entirely); `QueryBuilder.forceUpdate()` is the trusted-data escape hatch.
  - **Redis stores are now importable**: `@guren/core/redis` (and `@guren/server/redis`) ship `RedisSessionStore`, `RedisRateLimitStore`, `RedisSlidingWindowRateLimitStore`, `RedisApiTokenStore`, `RedisPasswordResetStore`, `RedisEmailVerificationStore`, and the new `RedisOAuthStateStore`. The default `MemoryOAuthStateStore` is now bounded (10k entries with expiry sweep) to prevent memory-exhaustion DoS.
  - **`PaginationMeta` name collision resolved**: the ORM's pagination meta is now `ModelPaginationMeta`; `PaginationMeta` from `@guren/core` unambiguously refers to the resource/paginator shape.
  - **React is a peer dependency**: `@guren/inertia-client` moves `react`/`react-dom` to peerDependencies, and `@guren/server` makes `@guren/inertia-client` an optional peer — API-only apps no longer pull React transitively.
  - **`@guren/testing/vitest` subpath**: vitest/React helpers move out of the root barrel so `bun:test` users don't need the React test stack; the related peer deps are marked optional.
  - **`Hash` is runtime-safe**: it now points at `DefaultHasher`, which delegates to Bun's scrypt on Bun and the Node implementation elsewhere (Lambda on Node no longer crashes).
  - Smaller freeze items: `ApplicationOptions`/`AuthPluginOptions` exported, unimplemented `Command.callSilent()` removed, `FormRequest` marked `@deprecated`, `MemoryQueueDriver`/`SyncQueueDriver`/`RedisQueueDriver` aliases added, internal ORM plumbing removed from the `@guren/core` allowlist, `nodemailer` bumped to v9 (HIGH advisory), stray `./dist/*` export wildcard removed.
  - **Docs**: broadcasting client flow rewritten around the `connected` handshake and `clientId` subscription (the previous example authorized but never subscribed), array-style query params documented, rc → 1.0.0 migration notes added, MySQL support matrix corrected, rate-limiting/serverless guides point at the shipped Redis stores.

- Updated dependencies [f7de890]
  - @guren/core@1.0.0-rc.26

## 1.0.0-rc.25

### Patch Changes

- a1fc6ec: Two security defaults locked in ahead of 1.0:

  - **Strict mass assignment.** When a model defines `fillable`, `create()`/`update()` now throw a `MassAssignmentException` naming any field outside the allowlist instead of silently discarding it (silent drops surfaced as NOT NULL violations far from the cause, and masked injection attempts). Use the new `forceCreate()` / `forceUpdate()` for trusted server-side data, or set `static strictFillable = false` per model to restore the old behavior. The `guarded` path is unchanged.
  - **`auth.user()` never exposes credentials.** The session guard sanitizes user records before caching or returning them: the password column, remember-token column, and the model's `static hidden` fields are stripped. Credential checks still run on the raw record internally, so login and remember-me behave exactly as before — but sharing `auth.user` into Inertia props no longer leaks `passwordHash` to the browser. Custom user providers can opt in via the new optional `UserProvider.sanitize()`. `guren add auth` now generates the User model with `static hidden = ['passwordHash', 'rememberToken']`.

- Updated dependencies [a1fc6ec]
  - @guren/core@1.0.0-rc.25

## 1.0.0-rc.24

### Patch Changes

- c10691c: Three bug fixes ahead of 1.0:

  - **Nested eager loading now works at any depth** (#15). `User.with('posts.comments.author')` previously loaded two levels and silently left deeper relations unloaded when going through the query builder. `QueryBuilder` now delegates the full dotted path to `Model.loadRelationInto`, which recurses correctly.
  - **Auth context is available to middleware registered before `boot()`** (#13). The fallback auth context (apps without `options.auth`) is attached in the `Application` constructor, and the context resolves its session lazily — so `app.use(requireAuthenticated())` before `boot()` responds 401 instead of throwing, regardless of session middleware ordering.
  - **Route contracts accept array-style query strings** (#12). `?tag=a&tag=b` now reaches query schemas as `{ tag: ['a', 'b'] }` (single occurrences stay plain strings), matching the controller-side `validateQuery` behavior. Schemas that expect a plain string for a key clients may repeat should switch to `z.array(...)` or accept both.
  - **`guren add oauth` now generates code that compiles.** The scaffolded controller named its action `redirect`, shadowing the base `Controller.redirect()` helper (infinite recursion) and failing to typecheck; the route-param validator also rejected `string | undefined`. The action is now `redirectToProvider` and the validator handles missing params.

- Updated dependencies [c10691c]
  - @guren/core@1.0.0-rc.24

## 1.0.0-rc.23

### Patch Changes

- d3a0d2c: DX fixes from the i18n dogfooding lap:

  - **Middleware `c.header()` now reaches controller responses.** Handlers and controllers return raw `Response` objects, which bypassed Hono's response construction — headers staged via `c.header()` in upstream middleware (e.g. a locale cookie) were silently dropped. Route responses are now rebuilt through `c.newResponse()`, merging prepared headers (`Set-Cookie` appended, the handler's own headers winning otherwise).
  - **`TestApp.withHeaders()` / `withHeader()`**: send custom request headers on every request (Accept-Language, bearer tokens, …). Like `actingAs()` and `json()`, they return a new `TestApp` and compose freely.
  - **`shareInertiaProps()`** merges shared props over previously registered resolvers, so multiple providers can each contribute (auth, i18n, flash, …) without clobbering one another. `getInertiaSharedPropsResolver()` is now exported for manual composition.
  - **Docs**: global middleware must be attached in a provider's `register()` — routes mount before `boot()`, so `app.use()` from `boot()` never applies. Documented in the architecture guide (en/ja).

- Updated dependencies [d3a0d2c]
  - @guren/core@1.0.0-rc.23

## 1.0.0-rc.22

### Patch Changes

- afe4bfd: Two fixes surfaced by dogfooding i18n in a real app:

  - **CSRF cookie refresh no longer wipes other cookies.** `setXsrfCookie` replaced the `Set-Cookie` header on the finalized response, silently dropping any cookie appended by inner middleware or handlers (e.g. a `locale` cookie). It now appends.
  - **`I18nConfig` accepts a `loader` option** as the i18n guide documents. Previously only `path` existed, so `MemoryLoader` (or any custom `TranslationLoader`) could not be injected into `createI18n` / `new I18nManager()`. `loader` takes precedence over `path`.

- 7fbf1de: Accept Hono middleware as a terminal route handler:

  - **`RouteHandler` now includes `(c, next)` signatures**, so any Hono `MiddlewareHandler` — including `broadcast.sseMiddleware()` and `broadcast.authMiddleware()` — can be passed directly to `router.get()` / `router.post()` as the docs show, without wrapper closures or `as Promise<Response>` casts.
  - **Responses set via `c.res` are honored**: a middleware mounted as a handler that finalizes the response through `next()` or `c.res =` no longer gets clobbered by a synthesized `204 No Content`. Plain handlers returning `undefined` still produce `204`.

- Updated dependencies [afe4bfd]
- Updated dependencies [7fbf1de]
  - @guren/core@1.0.0-rc.22

## 1.0.0-rc.21

### Patch Changes

- 42c6053: Make SSE broadcasting actually reachable from clients:

  - **The SSE stream announces the connection** with a `connected` event carrying the `clientId` and any already-subscribed channels. Previously clients had no way to learn their id, and no HTTP path ever subscribed a client to a channel — SSE connections received pings but never a single broadcast event.
  - **`?channels=a,b` query subscriptions** on the SSE endpoint: requested channels are authorized against the connecting user (`sseMiddleware({ getUser })`) and subscribed before the stream starts, so a bare `EventSource` works for public channels.
  - **`POST /broadcasting/auth` subscribes as well as authorizes** when the payload includes the `clientId`, returning `{ authorized, subscribed }` per channel.
  - **Unregistered `private-`/`presence-` channels now default to deny** instead of public access — a missing channel registration no longer silently exposes a private channel.

- Updated dependencies [42c6053]
  - @guren/core@1.0.0-rc.21

## 1.0.0-rc.20

### Patch Changes

- 379d57e: First-class file uploads:

  - **`this.file(name)` / `this.files(name)` controller helpers** — read uploaded files from multipart requests (null/empty-safe, composes with other body reads via Hono's cached parseBody). Previously controllers had to call `this.request.parseBody()` and duck-type the result.
  - **`TestApp` accepts `FormData` bodies** — `csrf.post('/tasks/1/attachments', formData)` sends real multipart requests, so upload endpoints are finally testable.

- Updated dependencies [379d57e]
  - @guren/core@1.0.0-rc.20

## 1.0.0-rc.19

### Patch Changes

- 4011200: Second round of real-app (Kadai) fixes:

  - **@guren/cli codegen: inherited page props are no longer dropped.** `interface Props extends PaginatedPageProps<T> { ... }` now extracts as an intersection of the heritage clauses and the body. Previously only the body was captured — an empty-bodied extends silently degraded the page contract to `{}` (no type checking at all), and adding any own member made the inherited members vanish from the contract, rejecting valid controller props.
  - **@guren/testing: `TestApp.withCsrf()`** primes CSRF like a real browser — GETs a page, captures the session and XSRF-TOKEN cookies, and sends them (plus `X-XSRF-TOKEN`) on subsequent requests, so mutating endpoints are finally testable against apps with CSRF enabled.
  - **@guren/orm: `GUREN_QUIET_DUPLICATE_ORM=1`** silences the duplicate-copy warning for environments where two copies coexist by design (e.g. monorepo dev with src + dist).

- Updated dependencies [4011200]
  - @guren/core@1.0.0-rc.19

## 1.0.0-rc.18

### Patch Changes

- 57f6f35: Fixes and features from building a real app (Kadai) on the published packages:

  - **@guren/server: entry bundles now share chunks** (tsup `splitting: true`). Each entry point previously bundled its own copy of module-level state, so `registerJob()` via the root entry and `Worker` via `./queue` used different job registries — jobs failed with "Job class not found". The same duplication affected the mail manager and queue driver globals.
  - **@guren/server: new `SyncDriver` (queue) and `LogTransport` (mail)** — the template `.env` defaults (`QUEUE_CONNECTION=sync`, `MAIL_MAILER=log`) previously named drivers that did not exist. Sync dispatch executes jobs inline with no worker process; the log transport writes full messages to server output. The `add queue` / `add mail` blueprints now honor these env vars and default to sync/log.
  - **@guren/orm: multi-relation type fix** — `findWith(id, ['a', 'b'])` and `with(['a', 'b'])` typed their results as a union of single-relation picks instead of an intersection, making relation properties inaccessible.
  - **@guren/orm: `QueryBuilder.paginate()` accepts an options object** (`{ page, perPage }`) in addition to positional arguments, matching `Model.paginate()`.

- Updated dependencies [57f6f35]
  - @guren/core@1.0.0-rc.18

## 1.0.0-rc.17

### Patch Changes

- 8ee89bb: Quality hardening: database-matrix runtime gates, upgrade-path protection, and add-on runtime smokes:

  - **PostgreSQL golden-path gate**: the scaffold→auth→CRUD runtime smoke now also runs against PostgreSQL in CI and the release workflow (dedicated `guren_smoke` database locally so developer data is never touched), verifying dialect-aware scaffolds, `resetDatabase()`, and `migrationStatus()` on pg for every release.
  - **`guren upgrade` works for the rc channel**: previously only `--canary` was supported, leaving rc users with no tool-assisted upgrade. `guren upgrade` now aligns every `@guren/*` package to a resolved dist-tag version (default `rc`, override with `--tag`), and warns when nested duplicate `@guren` copies survive in node_modules with the exact dedupe command.
  - **Duplicate-copy runtime guard**: loading two copies of `@guren/orm` (mixed versions) now prints a loud diagnostic explaining why database access fails and how to fix it, instead of failing silently with "database has not been configured".
  - **`Mail#build()` runs automatically**: scaffolded mailables previously threw "Email must have a subject" because `send()`/`queue()` never invoked `build()` — every user following the `add mail` scaffold hit this. Found by the new add-on runtime smoke, which now dispatches the scaffolded queue job and sends the scaffolded mailable on every release.

- Updated dependencies [8ee89bb]
  - @guren/core@1.0.0-rc.17

## 1.0.0-rc.16

### Patch Changes

- bba40d6: Runtime release gate, unified drizzle-kit migrations, and richer relations:

  - **Golden-path runtime smoke**: the release workflow now boots a scaffolded app and drives login, CRUD, CSRF, and auth rejection over HTTP before publishing — the class of published-artifact-only breakage fixed in rc.20 can no longer ship.
  - **Migrations unified on drizzle-kit**: `createSqliteDatabase`/`createPostgresDatabase`/`createMySqlDatabase` now expose `resetDatabase()` and `migrationStatus()`, making `guren db:reset`, `db:fresh`, and `db:status` work out of the box (all three previously failed on scaffolded apps). `db:rollback` now explains that drizzle-kit migrations are forward-only and points to `db:reset` or a compensating forward migration; the dead flat-SQL rollback tracker was removed.
  - **Relations**: nested eager loading with dot notation (`User.with('posts.comments')` — previously documented but not implemented) and `withCount()` (`users[0].postsCount`) for hasMany/hasOne/belongsTo/morphMany. Relation declarations no longer need `typeof` guards or `as any` casts; the testing mocks now include relation registrars so model modules load cleanly under Vitest.
  - Templates export `resetDatabase`/`migrationStatus` from config/database.ts and ship `db:reset`/`db:status` scripts; relationship docs updated (EN/JA) with the clean declaration pattern and `withCount`.

- Updated dependencies [bba40d6]
  - @guren/core@1.0.0-rc.16

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
  - @guren/core@1.0.0-rc.15

## 1.0.0-rc.14

### Patch Changes

- Secure-by-default hardening and AI-agent tooling:

  - `guren audit` command: validates auth/validation coverage on mutating routes, detects raw SQL, secrets, and mass assignment risks
  - `make:feature` now scaffolds auth checks by default (`--public` to opt out) and supports `--policy`
  - Authorization gate wiring, hardened auth/storage/mail/error rendering
  - Inertia asset version mismatch handling
  - drizzle-orm / drizzle-kit upgraded to 1.0.0-rc.1
  - Migration tracker SQL escaping fix and dependency vulnerability patches

- Updated dependencies
  - @guren/core@1.0.0-rc.14

## 1.0.0-rc.13

### Patch Changes

- feat(cli): add @guren/plugin-vercel and remove legacy deploy vercel target
  fix(create-app,orm,cli): fix blog blueprint SQLite support and DX issues
  fix(create-app): comment out VITE_DEV_SERVER_URL in template .env
- Updated dependencies
  - @guren/core@1.0.0-rc.13

## 1.0.0-rc.12

### Patch Changes

- fix(server): use figlet importable-fonts for bundled builds
- Updated dependencies
  - @guren/core@1.0.0-rc.12

## 1.0.0-rc.11

### Patch Changes

- fix(ci): upgrade to Node 24 for npm OIDC trusted publishing
- Updated dependencies
  - @guren/core@1.0.0-rc.11

## 1.0.0-rc.10

### Patch Changes

- Align all packages to rc.10.
- Updated dependencies
  - @guren/core@1.0.0-rc.10

## 1.0.0-rc.9

### Major Changes

- Promote OpenAPI package to v1.0 alongside other packages.

## 0.2.0-rc.8

### Patch Changes

- Updated dependencies
  - @guren/core@1.0.0-rc.8
