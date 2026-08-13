# @guren/core

## 1.6.0

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

- Updated dependencies [9452c71]
- Updated dependencies [684db66]
- Updated dependencies [3e39cc1]
- Updated dependencies [dbd2e64]
- Updated dependencies [0e615fc]
- Updated dependencies [dd9a5df]
  - @guren/server@2.5.0
  - @guren/cli@2.4.0
  - @guren/orm@2.3.0

## 1.5.2

### Patch Changes

- 72bd945: Degrade a corrupt ability list to no abilities instead of every ability

  `DatabaseApiTokenStore` decoded `abilities` with
  `decodeJsonColumn<string[]>(value, [])`, which returns whatever the JSON
  decodes to. A stored `'"*"'` decodes to the _string_ `"*"`, and `tokenCan` then
  runs `String.prototype.includes` on it, so `"*".includes("*")` is true and the
  token is granted every ability — the exact opposite of the deny-by-default the
  file's own comment claimed. `RedisApiTokenStore` had the same collapse, and its
  `JSON.parse` was unguarded besides, so one corrupt record threw on every
  verification of that token rather than degrading.

  Both stores now require an array and keep only its string members. A value that
  is not a list of strings yields no abilities.

- 72bd945: Treat an unparseable expiry as expired, at the point the decision is made

  `new Date(garbage)` is an Invalid Date, and every comparison against one is
  false. So `new Date() > token.expiresAt` and `payload.expiresAt.getTime() <= now`
  both read a corrupt expiry as _not past_, and the record never expired.

  The authoritative checks are `verifyApiToken` and the OAuth state store's expiry
  tests, not any one store's deserialization — a token reaches `verifyApiToken`
  from `MemoryApiTokenStore`, from the database and Redis stores, and from
  application-supplied stores the framework never sees. `createApiToken` could also
  mint an Invalid Date on its own from a non-finite `expiresIn`, with no store
  involved at all. Both now go through a shared predicate in
  `@guren/server/support/expiry`, so the rule holds for every implementation
  including ones written by users.

  Store-level coercion is kept as defense in depth and is now consistent. `toDate`
  promised in its docstring that unparseable values return `null` but passed
  `Date` instances wrapping garbage straight through, which is why `isExpired`
  carried a second NaN check of its own; it now normalizes through one path and
  handles the `bigint` a BIGINT column returns. `toOptionalExpiry` keeps absent
  (`null`, "never expires") and present-but-unparseable distinct, degrading the
  latter to a long-past date rather than to `null`. `RedisApiTokenStore`,
  `RedisOAuthStateStore`, `RedisPasswordResetStore` and
  `RedisEmailVerificationStore` all read their expiry through the same helper —
  the last two still had the original unguarded `new Date(parsed.expiresAt)`.

- b210a53: Collapse the duplicated store expiry rules into a single implementation

  `toDate`, `isExpired` and `toOptionalExpiry` existed twice: once in
  `packages/server/src/support/expiry.ts` for the Redis-backed stores and the
  authoritative `verifyApiToken` / OAuth checks, and once in
  `packages/core/src/store-utils.ts` for the database-backed stores. The copies
  were identical and deliberate — `@guren/core` depends on `@guren/server` and
  not the other way around, so core was unreachable from the server package —
  but two copies of an expiry rule is how the next boundary-case fix lands in
  one backend and silently misses its sibling. That is the failure mode the
  Redis and database stores have already hit once.

  `@guren/server` now exposes the rules on a `@guren/server/support/expiry`
  subpath and `packages/core/src/store-utils.ts` re-exports them, leaving one
  implementation for both backends. The dependency direction already ran
  core → server, so this adds no cycle.

  No behavior change and no public API change: the two implementations were
  byte-identical, and neither package's index exports these — `@guren/core`'s
  index opens with `export * from '@guren/server'`, so a test now pins that they
  stay off the public surface. `decodeJsonColumn` stays in core as a drizzle
  column concern; the Redis stores decode their payloads through
  `redis-values.ts`.

- Updated dependencies [72bd945]
- Updated dependencies [4b2b283]
- Updated dependencies [72bd945]
- Updated dependencies [72bd945]
- Updated dependencies [eebd978]
- Updated dependencies [2a6eef4]
- Updated dependencies [72bd945]
- Updated dependencies [72bd945]
- Updated dependencies [f43684c]
- Updated dependencies [72bd945]
- Updated dependencies [078bc93]
- Updated dependencies [eaafc8b]
- Updated dependencies [e22b10f]
- Updated dependencies [ae79279]
- Updated dependencies [3453540]
- Updated dependencies [e22b10f]
- Updated dependencies [b590b24]
- Updated dependencies [be4fa25]
- Updated dependencies [d7f4cb5]
- Updated dependencies [c84d760]
- Updated dependencies [633c9bc]
- Updated dependencies [72bd945]
- Updated dependencies [2c5886e]
- Updated dependencies [de3298b]
- Updated dependencies [d3da91c]
- Updated dependencies [19f7119]
- Updated dependencies [b210a53]
- Updated dependencies [e87d053]
  - @guren/cli@2.3.0
  - @guren/server@2.3.0
  - @guren/orm@2.2.1

## 1.5.1

### Patch Changes

- 80ef7b1: Persist the OAuth state binding in the shared state stores

  `createOAuthState` recorded the browser binding in the payload, but
  `DatabaseOAuthStateStore` and `RedisOAuthStateStore` neither wrote nor restored
  it. Every bound state came back unbound, and `verifyOAuthState` then accepted
  any browser — so `authorize({ bindTo })` was inert on both shared stores,
  including the database store the docs recommend for production. Only the
  in-process memory store, which the docs tell you not to deploy, carried it.

  Both stores now round-trip `binding`. The database store needs a nullable
  `binding` column on the `oauth_states` table; without it the state cannot be
  persisted at all.

  `bindingMatches` also moves to `secureCompare`, the hex-decoding comparator, to
  match the other stored-hash comparison in the package.

- Updated dependencies [80ef7b1]
- Updated dependencies [80ef7b1]
- Updated dependencies [05f6353]
- Updated dependencies [80ef7b1]
- Updated dependencies [ee5a918]
- Updated dependencies [ee5a918]
- Updated dependencies [89adb3f]
- Updated dependencies [80ef7b1]
- Updated dependencies [80ef7b1]
- Updated dependencies [80ef7b1]
- Updated dependencies [80ef7b1]
- Updated dependencies [80ef7b1]
- Updated dependencies [80ef7b1]
- Updated dependencies [80ef7b1]
- Updated dependencies [80ef7b1]
  - @guren/server@2.2.0
  - @guren/cli@2.2.0
  - @guren/orm@2.2.0

## 1.5.0

### Minor Changes

- e2c82da: Type the seeder context against the app's own database dialect

  `SeederContext.db` was hard-typed as `PostgresJsDatabase`, so every seeder was
  typed against PostgreSQL no matter which database the app configured. On MySQL
  and SQLite that made the seeder reject its own `db/schema.ts` — `db.insert()`
  does not accept a `mysqlTable`/`sqliteTable`, and `.onDuplicateKeyUpdate()` is
  not a method on the PostgreSQL insert builder at all. The runtime was always
  fine: the callback receives the real database.

  It was invisible in the default scaffold because `db/` was outside the app's
  `tsconfig.json` `include`, but not everywhere — the API-only template already
  typechecks `db/`, so `guren add auth` on a `--db mysql` API app failed
  `bun run typecheck` on the seeder it had just generated.

  `SeederContext` and `SeederHandler` are now generic over the database, with the
  same `PostgresJsDatabase` default as before, so existing seeders keep compiling.
  `PostgresSeederContext`, `MySqlSeederContext`, `SqliteSeederContext`, and
  `AwsDataApiSeederContext` are exported for the other drivers that seed (D1 does
  not — its `seedDatabase()` throws), and scaffolded apps re-export the one they
  configured from `config/database.ts` as `AppSeederContext`:

  ```ts
  import { defineSeeder } from "@guren/core";
  import type { AppSeederContext } from "../../config/database.js";

  export default defineSeeder(async ({ db }: AppSeederContext) => {
    /* ... */
  });
  ```

  `guren add auth` and `make:seeder` now annotate what they generate, and `db/`
  joined the default template's `tsconfig.json` `include` so the generated
  seeders and schema are actually typechecked. `runSeeders()` and `loadSeeders()`
  accept any dialect's database, which drops the casts the MySQL, SQLite, and
  Aurora Data API drivers needed.

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

- fe0c13d: Add a README. `@guren/core` is the package every Guren app imports from, yet
  its npm page was blank. The README covers install, a minimal controller and
  route example, the package's entry points (`/runtime`, `/vite`, `/lambda`,
  `/redis`), and links to the docs site.
- fe0c13d: fix: compute deploy-bundle import specifiers from real paths

  `buildLambdaOutput({ outputDir })` failed with `Bundle failed` whenever the
  output directory was reached through a symlink that changes path depth — on
  macOS `/tmp` is a link to `/private/tmp` and `os.tmpdir()` lives under
  `/var/folders`, a link into `/private/var`, so pointing a build script or CI
  harness at a temp directory hit this immediately.

  The generated `handler.ts` imports the app entrypoint through a relative
  specifier, and `importSpecifier()` computed it from the paths as given while
  the bundler resolves the emitted file from its real path. A depth-changing
  link left the specifier one `..` short. Both arguments now resolve through
  `realpathOfNearestExisting()` first — the same normalization the module's
  deletion guard already applies.

  The default `<root>/.lambda` output and the `lambda:build` command were never
  affected; only programmatic calls passing an explicit `outputDir` were.

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

- Updated dependencies [55d6a28]
- Updated dependencies [2c944f0]
- Updated dependencies [5c91e8e]
- Updated dependencies [63fd323]
- Updated dependencies [e2c82da]
- Updated dependencies [22f2526]
- Updated dependencies [d7e80fe]
- Updated dependencies
- Updated dependencies [02eb9cd]
- Updated dependencies [396194d]
- Updated dependencies [df90e04]
- Updated dependencies [559cc79]
- Updated dependencies [f5911d4]
- Updated dependencies [ec0233d]
- Updated dependencies [460e0e2]
- Updated dependencies [cda337b]
- Updated dependencies [d9165df]
- Updated dependencies [1bccf80]
  - @guren/cli@2.0.0
  - @guren/orm@2.0.0
  - @guren/server@2.0.0

## 1.4.0

### Minor Changes

- a7aec95: Add `createAwsDataApiDatabase()` for Aurora Serverless v2 via the RDS Data API.

  The factory mirrors the other database factories (`getDatabase`, `migrateDatabase`,
  `configureOrm`, `seedDatabase`, `resetDatabase`, `migrationStatus`) on top of
  `drizzle-orm/aws-data-api/pg`. The Data API is HTTP-based, so Lambda apps get a
  Postgres-compatible connection without a connection pool, RDS Proxy, or VPC
  placement. Connection settings resolve from options or the `DATABASE_NAME`,
  `DATABASE_RESOURCE_ARN`, and `DATABASE_SECRET_ARN` environment variables;
  `@aws-sdk/client-rds-data` is an optional peer dependency. Unlike the other
  factories, `getDatabase()` does not run pending migrations automatically —
  on Lambda that check costs serialized Data API round trips on every cold
  start. Run migrations out of band, or opt back in with `migrateOnStart: true`.

- 4b8ed69: Share the deploy plugins' build-time helpers through `@guren/core/internal/deploy-build`

  The Cloudflare, Lambda, and Vercel plugins each carried their own copy of the
  manifest and path helpers, the static-asset staging step, and the SSR manifest
  lookup. Cloudflare and Lambda separately listed the dev-only modules a deployed
  bundle has to stub. That list describes the module graph of any app importing
  `@guren/core`, so keeping it in two places had already let the copies drift.

  Four behaviour fixes fall out of the plugins now sharing one implementation:

  - `buildVercelOutput` gained the output-directory guard it never had. It
    deletes `outputDir` before writing, so pointing it at the project previously
    deleted the source tree.
  - No plugin accepts the filesystem root as `outputDir`. The old check compared
    strings, and `out + sep` is `//` at the root, which no absolute path is
    prefixed by.
  - `buildCloudflareOutput` and `buildVercelOutput` now honour a custom
    `publicDir` when reading the client manifest instead of always looking under
    `<root>/public`. Vercel likewise honours `ssrDir`.
  - `buildVercelOutput` no longer reports `GUREN_INERTIA_SSR_MANIFEST` as
    `.vite/manifest.json` when the SSR build emitted the flat `manifest.json`
    layout instead.

  `buildVercelOutput` now fails when the SSR manifest names a chunk that is not
  on disk, or one that escapes the SSR output directory. It previously wrote the
  entry into the function environment unchecked, so a stale or partial SSR build
  deployed and fell back to client-side rendering at request time. Cloudflare and
  Lambda already treated this as fatal. It also checks the entrypoint exists
  before deleting the previous output — the spawned `bun build` caught a missing
  `src/vercel.ts` too, but only after the last deployable artifact was gone.

  Stubs for the dev-only modules are emitted as throwing functions rather than
  classes. The stubbed names mix constructors (`new Database()`) with plain calls
  (`createServer()`), and only a function reports the intended message under
  both — a class invoked without `new` reports "Class constructor cannot be
  invoked without 'new'" instead.

### Patch Changes

- Updated dependencies [a7aec95]
- Updated dependencies [0dabfaa]
- Updated dependencies [d857bd8]
- Updated dependencies [c8f89d7]
- Updated dependencies [473ac6c]
- Updated dependencies [e5b8688]
- Updated dependencies [f365707]
- Updated dependencies [7d18f07]
- Updated dependencies [27137f9]
- Updated dependencies [f448a0a]
- Updated dependencies [3d67c4b]
- Updated dependencies [aa091f7]
- Updated dependencies [4e8ccc2]
- Updated dependencies [ba3aae4]
- Updated dependencies [704d407]
- Updated dependencies [5c3ba53]
  - @guren/orm@1.3.0
  - @guren/cli@1.6.0
  - @guren/server@1.5.0

## 1.3.0

### Minor Changes

- 88b45c4: Added `DatabaseSessionStore` and `DatabaseOAuthStateStore` (RFC 0003 Part 3) — database-backed stores built on the Guren ORM, next to the existing `DatabaseApiTokenStore`. Both work on any configured connection (SQLite, Postgres, MySQL, Cloudflare D1), which makes them the serverless defaults: sessions no longer require Redis on Lambda/Vercel/Workers (reads are strongly consistent, so login → redirect → read works), and OAuth state survives the authorize redirect landing on a different instance than the callback — the default `MemoryOAuthStateStore` is per-isolate memory and cannot guarantee that.

  Expired rows are treated as missing (and removed, guarded so a concurrently refreshed row survives) on read; expiry checks fail closed — a missing or unparseable `expiresAt` (including postgres.js bigint numeric strings) counts as expired. Both stores expose `deleteExpired()` for scheduled bulk cleanup, mirroring `DatabaseApiTokenStore`. Schema shapes are documented on each class (`sessions`: `id`/`data`/`expiresAt`; `oauth_states`: `stateHash`/`provider`/`redirectTo`/`expiresAt`). Session values must be JSON-serializable (documented on the class).

  Minor behavior fix in `DatabaseApiTokenStore`: a corrupt text-mode `abilities` column now degrades to an empty ability list (deny-by-default) instead of throwing on every verification of the affected token.

- 360d1f4: Added `createD1Database` — the Cloudflare D1 factory (RFC 0003 Part 2), alongside the postgres/mysql/sqlite factories and re-exported from `@guren/core`. It takes a deferred `binding` resolver (`binding: () => getWorkersEnv<Env>().DB` — bindings reach runtime-portable app code via the plugin's write-once holder, populated on the first request) and wires `drizzle-orm/d1` into the ORM adapter. D1 speaks the SQLite dialect, so schemas written for `createSqliteDatabase` port unchanged.

  The operational surface is deliberately different from the other factories: `migrateDatabase()`, `seedDatabase()`, `resetDatabase()`, and `migrationStatus()` throw with guidance instead of executing — wrangler owns the D1 migration lifecycle (`wrangler d1 migrations apply` over the same drizzle-kit-generated SQL files, `migrations_dir` pointing at `db/migrations`). The drizzle-kit SQL format contract (statement-breakpoint separators, filename ordering, idempotent re-apply) is covered by an opt-in end-to-end test against wrangler's local D1 (`GUREN_TEST_WRANGLER=1`).

- 1a6b738: Reduced session write volume (RFC 0003 Part 3): the session middleware no longer persists on every request, which matters anywhere writes are metered (Cloudflare D1's free tier allows 100k row writes/day — previously every page view consumed one).

  - **Empty new sessions are not persisted and issue no cookie.** An anonymous request that never stores anything now costs zero store operations. Sessions (and their cookie) appear the moment anything is stored. Apps that relied on every visitor receiving a session cookie unconditionally will see it appear on first actual session use instead. (With the default auth stack this happens on the first CSRF-protected page, unchanged for now.)
  - **Flash aging only dirties sessions that carried flash data**, instead of marking every loaded session dirty on every request.
  - **New optional `SessionStore.touch(id, ttlSeconds)`** — rolling expiry for unchanged sessions becomes a TTL refresh instead of a full data rewrite. Implemented in `MemorySessionStore`, `RedisSessionStore` (EXPIRE), and `DatabaseSessionStore` (single UPDATE). Stores without `touch` keep the previous full-write fallback, and touching a missing session is a no-op — an expired session is no longer resurrected as an empty row by its stale cookie.

### Patch Changes

- Updated dependencies [5196935]
- Updated dependencies [5196935]
- Updated dependencies [f7186c7]
- Updated dependencies [6ec0cfe]
- Updated dependencies [7a128ed]
- Updated dependencies [c395b27]
- Updated dependencies [0138070]
- Updated dependencies [b49e052]
- Updated dependencies [3d6b5d5]
- Updated dependencies [97aa6c7]
- Updated dependencies [c9095a1]
- Updated dependencies [8d1f495]
- Updated dependencies [0b8ec64]
- Updated dependencies [ac6e4ce]
- Updated dependencies [8beb966]
- Updated dependencies [6cfdb5c]
- Updated dependencies [f7186c7]
- Updated dependencies [88e6d4f]
- Updated dependencies [f7186c7]
- Updated dependencies [f7186c7]
- Updated dependencies [0131222]
- Updated dependencies [10a9bd1]
- Updated dependencies [8d1f495]
- Updated dependencies [360d1f4]
- Updated dependencies [a2c7b8c]
- Updated dependencies [d5d0c5b]
- Updated dependencies [db4450e]
- Updated dependencies [52dbaaf]
- Updated dependencies [7fc5692]
- Updated dependencies [1a6b738]
- Updated dependencies [6905725]
- Updated dependencies [f60c041]
  - @guren/server@1.4.0
  - @guren/cli@1.5.0
  - @guren/orm@1.2.0

## 1.2.0

### Minor Changes

- 0c01602: Accept dot-notation nested relation paths (`with('comments.author')`) in the type signatures of `with()`, `findWith()`, `findWithOrFail()`, and `withPaginate()` — the runtime already supported them. Add `BelongsToRequiredRecord<T>` for belongsTo relations backed by a NOT NULL foreign key, so `relationTypes` can declare the parent as non-nullable (use the `declare` modifier to skip the runtime placeholder).

### Patch Changes

- Updated dependencies [20e7aa4]
- Updated dependencies [60e2859]
- Updated dependencies [0c01602]
- Updated dependencies [df571cf]
- Updated dependencies [a10aa54]
  - @guren/cli@1.4.0
  - @guren/orm@1.1.0

## 1.1.0

### Minor Changes

- 2bbc832: Add `DatabaseApiTokenStore`, a database-backed `ApiTokenStore` built on the Guren ORM. Pass the Drizzle table for your `api_tokens` schema and it plugs into `createApiToken`/`verifyApiToken` and the bearer-token middleware with no custom store code, using the app's configured ORM connection. Includes `deleteExpired()` for scheduled pruning and an `abilitiesMode: 'text'` option for plain-text JSON ability columns (JSON-capable columns are the default). The API tokens guide previously told users to hand-roll this class — it now documents the built-in store and the recommended schema.

### Patch Changes

- Updated dependencies [d7be76a]
- Updated dependencies [9576668]
- Updated dependencies [15b4be0]
- Updated dependencies [6e0efe2]
- Updated dependencies [2f7aae5]
- Updated dependencies [2f7aae5]
- Updated dependencies [494ac11]
- Updated dependencies [7683c66]
- Updated dependencies [b1098cf]
  - @guren/cli@1.2.0
  - @guren/server@1.3.0

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
- d3a0d2c: DX fixes from the i18n dogfooding lap:

  - **Middleware `c.header()` now reaches controller responses.** Handlers and controllers return raw `Response` objects, which bypassed Hono's response construction — headers staged via `c.header()` in upstream middleware (e.g. a locale cookie) were silently dropped. Route responses are now rebuilt through `c.newResponse()`, merging prepared headers (`Set-Cookie` appended, the handler's own headers winning otherwise).
  - **`TestApp.withHeaders()` / `withHeader()`**: send custom request headers on every request (Accept-Language, bearer tokens, …). Like `actingAs()` and `json()`, they return a new `TestApp` and compose freely.
  - **`shareInertiaProps()`** merges shared props over previously registered resolvers, so multiple providers can each contribute (auth, i18n, flash, …) without clobbering one another. `getInertiaSharedPropsResolver()` is now exported for manual composition.
  - **Docs**: global middleware must be attached in a provider's `register()` — routes mount before `boot()`, so `app.use()` from `boot()` never applies. Documented in the architecture guide (en/ja).

- 379d57e: First-class file uploads:

  - **`this.file(name)` / `this.files(name)` controller helpers** — read uploaded files from multipart requests (null/empty-safe, composes with other body reads via Hono's cached parseBody). Previously controllers had to call `this.request.parseBody()` and duck-type the result.
  - **`TestApp` accepts `FormData` bodies** — `csrf.post('/tasks/1/attachments', formData)` sends real multipart requests, so upload endpoints are finally testable.

- da8707f: The release build runs build:create-app so the CLI binary is bundled.
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

- 08ac277: Updated the scaffolded app template so new projects pull in the freshly published prerelease.
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

- 11e876c: first release
- Updated dependencies [c2f318d]
- Updated dependencies [e74eab5]
- Updated dependencies [9333048]
- Updated dependencies [dcee3ee]
- Updated dependencies [b3c9414]
- Updated dependencies [73d311c]
- Updated dependencies [7687a0f]
- Updated dependencies [5fbd7e7]
- Updated dependencies [83ca2c2]
- Updated dependencies [38bd637]
- Updated dependencies [d3a0d2c]
- Updated dependencies [379d57e]
- Updated dependencies [c2f318d]
- Updated dependencies [f9e7441]
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
- Updated dependencies [e0136bd]
- Updated dependencies [a835522]
- Updated dependencies [42c6053]
- Updated dependencies [ac73182]
- Updated dependencies [11e876c]
- Updated dependencies [73d311c]
  - @guren/server@1.0.0
  - @guren/cli@1.0.0
  - @guren/orm@1.0.0

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
  - @guren/server@1.0.0-rc.26
  - @guren/orm@1.0.0-rc.27
  - @guren/cli@1.0.0-rc.29

## 1.0.0-rc.25

### Patch Changes

- a1fc6ec: Two security defaults locked in ahead of 1.0:

  - **Strict mass assignment.** When a model defines `fillable`, `create()`/`update()` now throw a `MassAssignmentException` naming any field outside the allowlist instead of silently discarding it (silent drops surfaced as NOT NULL violations far from the cause, and masked injection attempts). Use the new `forceCreate()` / `forceUpdate()` for trusted server-side data, or set `static strictFillable = false` per model to restore the old behavior. The `guarded` path is unchanged.
  - **`auth.user()` never exposes credentials.** The session guard sanitizes user records before caching or returning them: the password column, remember-token column, and the model's `static hidden` fields are stripped. Credential checks still run on the raw record internally, so login and remember-me behave exactly as before — but sharing `auth.user` into Inertia props no longer leaks `passwordHash` to the browser. Custom user providers can opt in via the new optional `UserProvider.sanitize()`. `guren add auth` now generates the User model with `static hidden = ['passwordHash', 'rememberToken']`.

- Updated dependencies [a1fc6ec]
  - @guren/orm@1.0.0-rc.26
  - @guren/server@1.0.0-rc.25
  - @guren/cli@1.0.0-rc.28

## 1.0.0-rc.24

### Patch Changes

- c10691c: Three bug fixes ahead of 1.0:

  - **Nested eager loading now works at any depth** (#15). `User.with('posts.comments.author')` previously loaded two levels and silently left deeper relations unloaded when going through the query builder. `QueryBuilder` now delegates the full dotted path to `Model.loadRelationInto`, which recurses correctly.
  - **Auth context is available to middleware registered before `boot()`** (#13). The fallback auth context (apps without `options.auth`) is attached in the `Application` constructor, and the context resolves its session lazily — so `app.use(requireAuthenticated())` before `boot()` responds 401 instead of throwing, regardless of session middleware ordering.
  - **Route contracts accept array-style query strings** (#12). `?tag=a&tag=b` now reaches query schemas as `{ tag: ['a', 'b'] }` (single occurrences stay plain strings), matching the controller-side `validateQuery` behavior. Schemas that expect a plain string for a key clients may repeat should switch to `z.array(...)` or accept both.
  - **`guren add oauth` now generates code that compiles.** The scaffolded controller named its action `redirect`, shadowing the base `Controller.redirect()` helper (infinite recursion) and failing to typecheck; the route-param validator also rejected `string | undefined`. The action is now `redirectToProvider` and the validator handles missing params.

- Updated dependencies [c10691c]
  - @guren/server@1.0.0-rc.24
  - @guren/orm@1.0.0-rc.25
  - @guren/cli@1.0.0-rc.27

## 1.0.0-rc.23

### Patch Changes

- d3a0d2c: DX fixes from the i18n dogfooding lap:

  - **Middleware `c.header()` now reaches controller responses.** Handlers and controllers return raw `Response` objects, which bypassed Hono's response construction — headers staged via `c.header()` in upstream middleware (e.g. a locale cookie) were silently dropped. Route responses are now rebuilt through `c.newResponse()`, merging prepared headers (`Set-Cookie` appended, the handler's own headers winning otherwise).
  - **`TestApp.withHeaders()` / `withHeader()`**: send custom request headers on every request (Accept-Language, bearer tokens, …). Like `actingAs()` and `json()`, they return a new `TestApp` and compose freely.
  - **`shareInertiaProps()`** merges shared props over previously registered resolvers, so multiple providers can each contribute (auth, i18n, flash, …) without clobbering one another. `getInertiaSharedPropsResolver()` is now exported for manual composition.
  - **Docs**: global middleware must be attached in a provider's `register()` — routes mount before `boot()`, so `app.use()` from `boot()` never applies. Documented in the architecture guide (en/ja).

- Updated dependencies [d3a0d2c]
  - @guren/server@1.0.0-rc.23
  - @guren/orm@1.0.0-rc.24
  - @guren/cli@1.0.0-rc.26

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
  - @guren/server@1.0.0-rc.22
  - @guren/orm@1.0.0-rc.23
  - @guren/cli@1.0.0-rc.25

## 1.0.0-rc.21

### Patch Changes

- 42c6053: Make SSE broadcasting actually reachable from clients:

  - **The SSE stream announces the connection** with a `connected` event carrying the `clientId` and any already-subscribed channels. Previously clients had no way to learn their id, and no HTTP path ever subscribed a client to a channel — SSE connections received pings but never a single broadcast event.
  - **`?channels=a,b` query subscriptions** on the SSE endpoint: requested channels are authorized against the connecting user (`sseMiddleware({ getUser })`) and subscribed before the stream starts, so a bare `EventSource` works for public channels.
  - **`POST /broadcasting/auth` subscribes as well as authorizes** when the payload includes the `clientId`, returning `{ authorized, subscribed }` per channel.
  - **Unregistered `private-`/`presence-` channels now default to deny** instead of public access — a missing channel registration no longer silently exposes a private channel.

- Updated dependencies [42c6053]
  - @guren/server@1.0.0-rc.21
  - @guren/orm@1.0.0-rc.22
  - @guren/cli@1.0.0-rc.24

## 1.0.0-rc.20

### Patch Changes

- 379d57e: First-class file uploads:

  - **`this.file(name)` / `this.files(name)` controller helpers** — read uploaded files from multipart requests (null/empty-safe, composes with other body reads via Hono's cached parseBody). Previously controllers had to call `this.request.parseBody()` and duck-type the result.
  - **`TestApp` accepts `FormData` bodies** — `csrf.post('/tasks/1/attachments', formData)` sends real multipart requests, so upload endpoints are finally testable.

- Updated dependencies [379d57e]
  - @guren/server@1.0.0-rc.20
  - @guren/orm@1.0.0-rc.21
  - @guren/cli@1.0.0-rc.23

## 1.0.0-rc.19

### Patch Changes

- 4011200: Second round of real-app (Kadai) fixes:

  - **@guren/cli codegen: inherited page props are no longer dropped.** `interface Props extends PaginatedPageProps<T> { ... }` now extracts as an intersection of the heritage clauses and the body. Previously only the body was captured — an empty-bodied extends silently degraded the page contract to `{}` (no type checking at all), and adding any own member made the inherited members vanish from the contract, rejecting valid controller props.
  - **@guren/testing: `TestApp.withCsrf()`** primes CSRF like a real browser — GETs a page, captures the session and XSRF-TOKEN cookies, and sends them (plus `X-XSRF-TOKEN`) on subsequent requests, so mutating endpoints are finally testable against apps with CSRF enabled.
  - **@guren/orm: `GUREN_QUIET_DUPLICATE_ORM=1`** silences the duplicate-copy warning for environments where two copies coexist by design (e.g. monorepo dev with src + dist).

- Updated dependencies [4011200]
  - @guren/cli@1.0.0-rc.21
  - @guren/orm@1.0.0-rc.20
  - @guren/server@1.0.0-rc.19

## 1.0.0-rc.18

### Patch Changes

- 57f6f35: Fixes and features from building a real app (Kadai) on the published packages:

  - **@guren/server: entry bundles now share chunks** (tsup `splitting: true`). Each entry point previously bundled its own copy of module-level state, so `registerJob()` via the root entry and `Worker` via `./queue` used different job registries — jobs failed with "Job class not found". The same duplication affected the mail manager and queue driver globals.
  - **@guren/server: new `SyncDriver` (queue) and `LogTransport` (mail)** — the template `.env` defaults (`QUEUE_CONNECTION=sync`, `MAIL_MAILER=log`) previously named drivers that did not exist. Sync dispatch executes jobs inline with no worker process; the log transport writes full messages to server output. The `add queue` / `add mail` blueprints now honor these env vars and default to sync/log.
  - **@guren/orm: multi-relation type fix** — `findWith(id, ['a', 'b'])` and `with(['a', 'b'])` typed their results as a union of single-relation picks instead of an intersection, making relation properties inaccessible.
  - **@guren/orm: `QueryBuilder.paginate()` accepts an options object** (`{ page, perPage }`) in addition to positional arguments, matching `Model.paginate()`.

- Updated dependencies [57f6f35]
  - @guren/server@1.0.0-rc.18
  - @guren/orm@1.0.0-rc.19
  - @guren/cli@1.0.0-rc.20

## 1.0.0-rc.17

### Patch Changes

- 8ee89bb: Quality hardening: database-matrix runtime gates, upgrade-path protection, and add-on runtime smokes:

  - **PostgreSQL golden-path gate**: the scaffold→auth→CRUD runtime smoke now also runs against PostgreSQL in CI and the release workflow (dedicated `guren_smoke` database locally so developer data is never touched), verifying dialect-aware scaffolds, `resetDatabase()`, and `migrationStatus()` on pg for every release.
  - **`guren upgrade` works for the rc channel**: previously only `--canary` was supported, leaving rc users with no tool-assisted upgrade. `guren upgrade` now aligns every `@guren/*` package to a resolved dist-tag version (default `rc`, override with `--tag`), and warns when nested duplicate `@guren` copies survive in node_modules with the exact dedupe command.
  - **Duplicate-copy runtime guard**: loading two copies of `@guren/orm` (mixed versions) now prints a loud diagnostic explaining why database access fails and how to fix it, instead of failing silently with "database has not been configured".
  - **`Mail#build()` runs automatically**: scaffolded mailables previously threw "Email must have a subject" because `send()`/`queue()` never invoked `build()` — every user following the `add mail` scaffold hit this. Found by the new add-on runtime smoke, which now dispatches the scaffolded queue job and sends the scaffolded mailable on every release.

- Updated dependencies [8ee89bb]
  - @guren/orm@1.0.0-rc.17
  - @guren/cli@1.0.0-rc.19
  - @guren/server@1.0.0-rc.17

## 1.0.0-rc.16

### Patch Changes

- bba40d6: Runtime release gate, unified drizzle-kit migrations, and richer relations:

  - **Golden-path runtime smoke**: the release workflow now boots a scaffolded app and drives login, CRUD, CSRF, and auth rejection over HTTP before publishing — the class of published-artifact-only breakage fixed in rc.20 can no longer ship.
  - **Migrations unified on drizzle-kit**: `createSqliteDatabase`/`createPostgresDatabase`/`createMySqlDatabase` now expose `resetDatabase()` and `migrationStatus()`, making `guren db:reset`, `db:fresh`, and `db:status` work out of the box (all three previously failed on scaffolded apps). `db:rollback` now explains that drizzle-kit migrations are forward-only and points to `db:reset` or a compensating forward migration; the dead flat-SQL rollback tracker was removed.
  - **Relations**: nested eager loading with dot notation (`User.with('posts.comments')` — previously documented but not implemented) and `withCount()` (`users[0].postsCount`) for hasMany/hasOne/belongsTo/morphMany. Relation declarations no longer need `typeof` guards or `as any` casts; the testing mocks now include relation registrars so model modules load cleanly under Vitest.
  - Templates export `resetDatabase`/`migrationStatus` from config/database.ts and ship `db:reset`/`db:status` scripts; relationship docs updated (EN/JA) with the clean declaration pattern and `withCount`.

- Updated dependencies [bba40d6]
  - @guren/orm@1.0.0-rc.15
  - @guren/cli@1.0.0-rc.18
  - @guren/server@1.0.0-rc.16

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
  - @guren/server@1.0.0-rc.15
  - @guren/orm@1.0.0-rc.14
  - @guren/cli@1.0.0-rc.17

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
  - @guren/server@1.0.0-rc.14
  - @guren/cli@1.0.0-rc.16
  - @guren/orm@1.0.0-rc.13

## 1.0.0-rc.13

### Patch Changes

- feat(cli): add @guren/plugin-vercel and remove legacy deploy vercel target
  fix(create-app,orm,cli): fix blog blueprint SQLite support and DX issues
  fix(create-app): comment out VITE_DEV_SERVER_URL in template .env
- Updated dependencies
  - @guren/cli@1.0.0-rc.14
  - @guren/orm@1.0.0-rc.12
  - @guren/server@1.0.0-rc.13

## 1.0.0-rc.12

### Patch Changes

- fix(server): use figlet importable-fonts for bundled builds
- Updated dependencies
  - @guren/server@1.0.0-rc.12
  - @guren/cli@1.0.0-rc.13

## 1.0.0-rc.11

### Patch Changes

- fix(ci): upgrade to Node 24 for npm OIDC trusted publishing
- Updated dependencies
  - @guren/server@1.0.0-rc.11
  - @guren/orm@1.0.0-rc.11
  - @guren/cli@1.0.0-rc.11

## 1.0.0-rc.10

### Patch Changes

- Align all packages to rc.10.
- Updated dependencies
  - @guren/server@1.0.0-rc.10
  - @guren/cli@1.0.0-rc.10

## 1.0.0-rc.9

### Patch Changes

- Align all packages to rc.9.
- Updated dependencies
  - @guren/server@1.0.0-rc.9
  - @guren/orm@1.0.0-rc.9
  - @guren/cli@1.0.0-rc.9

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
  - @guren/server@1.0.0-rc.8
  - @guren/orm@1.0.0-rc.8
  - @guren/cli@1.0.0-rc.8

## 0.2.0-alpha.7

### Patch Changes

- Fix the project created with the `create-guren-app` command so it can start successfully.
- Updated dependencies
  - @guren/cli@0.2.0-alpha.7
  - @guren/orm@0.2.0-alpha.7
  - @guren/server@0.2.0-alpha.7

## 0.2.0-alpha.6

### Minor Changes

- Added SSR support, ORM relationships, pagination, and authentication enhancements.

### Patch Changes

- Updated dependencies
  - @guren/cli@0.2.0-alpha.6
  - @guren/orm@0.2.0-alpha.6
  - @guren/server@0.2.0-alpha.6

## 0.1.1-alpha.5

### Patch Changes

- Ensure dev asset server resolves and serves Inertia client chunks so the scaffold works in dev.
- Updated dependencies
  - @guren/cli@0.1.1-alpha.5
  - @guren/orm@0.1.1-alpha.5
  - @guren/server@0.1.1-alpha.5

## 0.1.1-alpha.4

### Patch Changes

- Fixed registerDevAssets to resolve the bundled Inertia client via @guren/inertia-client/app, rebuilt @guren/server, and confirmed the scaffolded app now loads without blank-screen 404s.
- Updated dependencies
  - @guren/cli@0.1.1-alpha.4
  - @guren/orm@0.1.1-alpha.4
  - @guren/server@0.1.1-alpha.4

## 0.1.1-alpha.3

### Patch Changes

- The release build runs build:create-app so the CLI binary is bundled.
- Updated dependencies
  - @guren/cli@0.1.1-alpha.3
  - @guren/orm@0.1.1-alpha.3
  - @guren/server@0.1.1-alpha.3

## 0.1.1-alpha.2

### Patch Changes

- Updated the scaffolded app template so new projects pull in the freshly published prerelease.
- Updated dependencies
  - @guren/cli@0.1.1-alpha.2
  - @guren/orm@0.1.1-alpha.2
  - @guren/server@0.1.1-alpha.2

## 0.1.1-alpha.1

### Patch Changes

- Pinned dependencies to specific versions for consistency across packages
- Updated dependencies
  - @guren/cli@0.1.1-alpha.1
  - @guren/orm@0.1.1-alpha.1
  - @guren/server@0.1.1-alpha.1

## 0.1.1-alpha.0

### Patch Changes

- 7f52ba4: Add open-source metadata, licensing, and community docs to prepare the packages for an initial public release.
- first release
- Updated dependencies [7f52ba4]
- Updated dependencies
  - @guren/server@0.1.1-alpha.0
  - @guren/orm@0.1.1-alpha.0
  - @guren/cli@0.1.1-alpha.0
