# create-guren-app

## 1.6.1

### Patch Changes

- 3eb8856: `create-guren-app` gives up on a stalled `git` instead of hanging

  `--git` shells out to `git init`, `git add -A`, and `git commit` through
  `spawnSync`, with no bound on how long any of them may take. That call blocks
  the process outright, so a `git` that stops making progress leaves the user
  staring at `Initializing git repository...` with the app already written to
  disk — nothing to do but Ctrl-C and guess at what state the repository is in.

  The child inherits no terminal, which is what makes this reachable rather than
  theoretical. A commit-signing passphrase prompt, a credential helper, or a
  stalled name lookup while git guesses the committer identity all wait on input
  that can never arrive. It surfaced as CI test timeouts, where one wedged
  `git commit` blocked the runner long enough to take down neighbouring tests too.

  Every invocation now runs under a 30-second budget — one budget shared across
  all three steps, so the whole call is bounded, not each subprocess
  independently — and a child that overruns it is killed. The result is the
  warning the scaffolder already printed when git failed outright:

  ```
  Created a git repository, but the initial commit failed (git identity may be unset).
  Set `git config user.name` and `git config user.email`, then run `git commit -m "chore: initial commit"`.
  ```

  The children also get `GIT_TERMINAL_PROMPT=0`, so git fails fast rather than
  waiting on a terminal it does not have. The probe that decides whether the
  target already sits inside a repository answers "yes" when it has to be killed:
  the scaffolder uses that answer to _decline_ `git init`, and declining on an
  unreadable answer beats nesting a repository inside the user's checkout. A
  missing git still answers "no", so a machine without git stays on the
  "initialize the repository manually" path rather than silently skipping the
  step.

  The bound is deliberately tied to how these particular children run rather than
  applied to every subprocess the scaffolder starts. `bun install` and the app's
  own CLI inherit the terminal — they can answer a prompt, they show progress,
  and a long one is visibly working, so a deadline there would kill a slow but
  healthy install. Only the git calls run silently with no terminal, where
  "stalled" and "working" look identical from the user's seat.

  Nothing changes for a scaffold where git behaves: the budget is far above what
  `git init`/`add`/`commit` take on a fresh app, and the repository is still
  created with the user's own `init.defaultBranch`, identity, and signing
  configuration rather than overrides forced by the scaffolder.

## 1.6.0

### Minor Changes

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

## 1.5.0

### Minor Changes

- b73c455: Re-add the `blog` blueprint as a template that ships

  `--blueprint blog` is back, this time as a curated template under `templates/`
  instead of an overlay of the `examples/blog` workspace, which no published
  tarball contains. It layers posts CRUD, session authentication, an ownership
  policy, and a seeded demo account over the default template, and it applies
  `default-ssr` in SSR mode — the blueprint it replaces skipped that layer and
  scaffolded an SSR app with no `ssr.tsx` entry.

  The schema comes from the template rather than a generator in `blueprints.ts`.
  A template can now ship `db/schema.<driver>.ts` per driver; the scaffolder keeps
  the one matching the selected database, renames it to `db/schema.ts`, and
  deletes the rest. A template that ships some drivers but not the selected one is
  reported as an incomplete build instead of silently falling back to the generic
  single-table schema, which would scaffold models pointing at tables that do not
  exist. This is what the old blueprint's hand-maintained schema copy existed to
  work around, and what let it drift from the columns its own controllers read.

  `--auth` is ignored for blueprints that already ship authentication, with a note
  saying so: it runs `guren add auth --force`, which would overwrite the
  template's own controllers, routes, and `User` model with the generic ones. The
  "add features" next steps no longer suggest adding auth to an app that has it.

  Two things the template does that `guren add auth`'s output does not, both
  found by driving the scaffolded app in a browser: it shares the signed-in user
  with Inertia from `AuthProvider.boot()`, without which every page renders as a
  guest and the authenticated nav never appears, and it logs out through an
  Inertia `Link` rather than a native `<form method="post">`, which carries no
  CSRF token and is rejected with a 403.

  `smoke:starter:blog` scaffolds, typechecks, and builds the blueprint in CI
  alongside the existing `api` and `worker` smokes. Like every other starter
  smoke it covers SQLite only; the PostgreSQL and MySQL schemas this blueprint
  ships were typechecked and run through `drizzle-kit generate` by hand.

  The `User` model follows RFC 0006's structural mass-assignment model
  (`defineModel(users, { base: AuthenticatableModel, ... })`, no `guarded`) —
  `passwordHash` and `rememberToken` are denied by `AuthenticatableModel` itself,
  and `Post.fillable` never lists `authorId`, which is set from the session via
  `forceCreate()` in `PostController.store()`.

- 22f2526: Remove the `blog` blueprint and guard against unpublishable template layers

  `--blueprint blog` never worked from a published `create-guren-app`. Its overlay
  layer resolved to `examples/blog`, which lives outside the package and is not
  covered by the `files` field, so from npm the command failed with a raw ENOENT
  inside `cp` after already copying the base template — leaving a half-scaffolded
  directory behind. `--help` advertised the blueprint the whole time.

  The blueprint was also broken independently of packaging: its hand-maintained
  copy of the blog schema had drifted from the columns its controllers used, and
  it pinned `@inertiajs/core` to a major version behind the `@inertiajs/react` the
  template installs, so a generated app did not typecheck even inside the
  monorepo. Restoring it means shipping a curated template under `templates/` with
  smoke coverage, which is tracked separately; advertising it meanwhile was worse
  than removing it. `--blueprint blog` now reports the blueprints that do exist.

  Template layers are now named rather than pathed, so a layer outside the
  published `templates/` directory is a type error instead of something a test has
  to catch. `scaffoldAppBlueprint()` also verifies each template exists before it
  copies anything, so a corrupted install reports which blueprint and directory are
  missing instead of an ENOENT, rather than failing part-way through the copy.

- f5911d4: Ship a `.gitignore` with scaffolded apps and offer an initial commit.

  npm strips files literally named `.gitignore` from published tarballs, so every
  app scaffolded from the registry came out without one — `git init` immediately
  staged `node_modules/`, build output, and the generated `.env`. Templates now
  carry the file as `_gitignore` and the scaffolder restores the dot after each
  template layer copies — collected from the copy itself, so a `--force` scaffold
  never renames files it did not write. The default list also covers
  `public/assets/`, `.guren/ssr/`, and `.DS_Store`.

  `create-guren-app` (and `guren new`) gained a `--git` / `--no-git` flag that
  initializes a repository and creates an initial commit once the harness and
  optional auth scaffolding are in place. It is prompted in an interactive
  terminal, off in non-interactive ones, and skipped when the target directory is
  already inside a git repository or already contained files — an initial commit
  must never sweep up anything the scaffolder did not write.

- ec0233d: Scaffold Postgres timestamp columns as `timestamptz`

  Every timestamp a Guren scaffold emitted for Postgres was `timestamp without
time zone`: `add resource`'s `date` fields, the `createdAt` it appends, the
  `createdAt`/`updatedAt`/`emailVerifiedAt` on `make:auth`'s users table, and the
  `users` table `create-guren-app --db postgres` writes. All of them hold an
  instant, so all of them are now `timestamp(name, { withTimezone: true })`.

  A column without a time zone stores a bare wall clock, and who reads it decides
  what that clock meant:

  - `defaultNow()` records the wall clock of the **database session's** time zone,
    while the app reads the column back as if it were UTC. Whenever the database
    session is not on UTC, a `createdAt` is silently off by that offset — the
    wrong instant is written, not merely displayed.
  - Values the app writes itself are UTC wall clock, so anything that is not
    Drizzle — `psql`, a raw `postgres` query, a report, another service — reads
    them as local time and sees a different instant.

  Drizzle parses the offset-less column as UTC, so an app that only ever reads
  through its own models stays self-consistent; `timestamptz` is what makes the
  column mean the same instant to everyone else.

  This changes generated code only — existing schemas are untouched. To adopt it
  in an app that has already migrated, change the column in `db/schema.ts` and
  generate a migration, then fix up the `USING` clause. Drizzle emits a bare
  `::timestamp with time zone` cast, which reinterprets stored values against
  whatever the session's time zone happens to be; name the zone the values were
  actually written in instead:

  ```sql
  ALTER TABLE "posts"
    ALTER COLUMN "published_at" SET DATA TYPE timestamp with time zone
    USING "published_at" AT TIME ZONE 'UTC';
  ```

  `'UTC'` is right for values the app wrote. If the column also carries
  `defaultNow()` rows, they were written in the database session's zone — check
  it with `SHOW TimeZone` before converting, and split the conversion if the two
  sets of rows disagree.

### Patch Changes

- 55d6a28: Make the generated API client CSRF-safe by default. `createApiClient()` now
  copies the `XSRF-TOKEN` cookie into the `X-XSRF-TOKEN` header on
  state-changing requests, so `client.request('posts.store', { body })` no
  longer gets a 403 from the CSRF middleware that ships enabled by default.

  The copy happens only when the request targets the page's own origin — the
  cookie belongs to that origin, and sending it to a third-party `baseUrl`
  would disclose the page's CSRF token. A cross-origin client, or one talking
  to a server configured with `csrf({ cookie: false })`, supplies its own
  `X-XSRF-TOKEN` header; caller-supplied `X-XSRF-TOKEN` / `X-CSRF-TOKEN`
  headers are left untouched whatever their casing. The cookie is read through
  `globalThis`, so the generated module stays import-safe during SSR.

  Requests also carry an explicit `credentials: 'same-origin'` — the fetch
  default, now overridable through the new `credentials` option.

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

- 02eb9cd: Keep `--db mysql` scaffolds on the MySQL dialect end to end

  `create-guren-app --db mysql` generated a `db/schema.ts` that imported
  `mysqlTable, int, varchar, timestamp` from `@guren/orm/drizzle`. That subpath
  re-exports the PostgreSQL column builders under the unqualified names, so the
  MySQL `users` table was built out of a pg `timestamp`. Nothing reported it:
  drizzle-kit still emitted the same MySQL DDL and the app still typechecked.

  It did leak further, though. `guren add auth` and `add resource` merge new
  columns into the schema's `drizzle-orm/mysql-core` import and skip any name
  already visible in some import line — so with a pg `timestamp` in scope, every
  later date column silently stayed on the wrong dialect too. The scaffold now
  imports from `drizzle-orm/mysql-core`, matching what the patchers emit and what
  the SQLite scaffold already did.

  The demo-user seeder `guren add auth` writes is now dialect-aware. It used
  `.onConflictDoNothing()` unconditionally, which does not exist on MySQL's query
  builder — `db:seed` threw `onConflictDoNothing is not a function` on every MySQL
  app. MySQL now gets the equivalent `.onDuplicateKeyUpdate()` form.

- 559cc79: Render route `body` types as the request shape, not the parsed one

  `ApiRoutes[...]['body']` is consumed as the wire type — generated pages hand it
  to `useForm`, and `createApiClient()` callers build request payloads from it —
  but codegen emitted the schema's post-parse type. Those differ for every
  coercing schema, and `z.coerce.date()` made the difference fatal: the body was
  typed `Date` while a browser can only send an ISO string, so a `make:feature`
  scaffold with a date field did not type-check at all.

  `body` now renders the input side, where a coerced date is a `string` and a
  coerced number is `number | string`. `response` still renders the parsed side,
  and `guren context` keeps showing params/query as the controller receives them.
  A `.pipe()` now resolves both sides independently; `.transform()` continues to
  report its input type, since a transform's output is a function with no
  recoverable type.

  Field _presence_ follows the same split, which it previously did not: a
  `.default()`, `.prefault()` or `.catch()` field may be omitted from a request
  but is always there once parsed, so it is optional in `body` and required in
  `response`. `.readonly()`, `.brand()` and `.nonoptional()` are now understood
  too — the first two previously made an optional field look required.

  **Regenerating may surface new type errors in app code**, and they are pointing
  at something real. A form field previously typed `Date` was already sending a
  string over the wire; one typed `number` may receive `"3"` from an input. Widen
  the local type, or narrow the schema if the route genuinely does not coerce.

  Fixed alongside, all of which blocked the same scaffold from compiling:

  - `z.array()` threw on Zod 4 and took `guren codegen` down with it, for any
    route whose body or output schema contained an array.
  - Zod 3's `ZodPipeline` was not recognized at all, so `z.string().pipe(...)`
    rendered as `unknown` on apps still pinned to Zod 3.
  - `RouteBody<>` constrained its registry to a type with an index signature,
    which the generated `ApiRoutes` interface can never satisfy — the type could
    not be used with the one registry it exists for. The constraint is gone, and
    generated form pages now use `RouteBody<ApiRoutes, 'posts.store'>` in place of
    indexing `ApiRoutes` directly.
  - A scaffolded `json` field validated with `z.record(z.unknown())`, which needs
    an explicit key type on Zod 4 and produces a value Inertia's `FormDataType`
    rejects. It is now `z.record(z.string(), z.any())`, edited through a textarea
    that tolerates mid-edit JSON while flagging it, and rendered with
    `JSON.stringify` instead of being passed to React as an object. A json column
    is also no longer used as the Index page's heading, where React refused to
    render it. Scaffolding a json field now emits a `useState` flag on the form
    pages, so a parse failure is visible rather than silently submitting the last
    value that parsed. Apps that customized this validator keep their own version;
    only newly scaffolded features change.
  - A scaffolded `date` field cast its column straight to `string` in the
    resource, and fed a full ISO timestamp to `<input type="date">`, which renders
    nothing for anything longer than `YYYY-MM-DD`. The resource now normalizes
    through `new Date(...)`, so it survives SQLite handing back a string where
    Postgres hands back a `Date`.
  - The scaffolded Edit page named its submit event `event`, shadowing the record
    prop for any entity whose variable name is also `event`.

  Two known limits, both deliberate:

  - Coerced types are rendered narrower than Zod would actually accept.
    `z.coerce.number()` also takes a `boolean` and `z.coerce.boolean()` takes
    anything at all, but a generated `body` is a type callers must _satisfy_, so
    it stays JSON-native and usable — a bare `boolean` is what drives a
    checkbox's `checked`. Widen the schema if a route really means "anything".
  - `RouteBody<>` returns `Record<string, unknown>` for a registry entry with no
    `body`, including a malformed one. Constraining the registry is not an option:
    a generated `interface` can never satisfy an index signature, which is the
    bug being fixed here.

- 468b898: Point the templates' `@guren/*` ranges at the versions they are published with

  Every template declared `"@guren/orm": "^1.0.0"` and friends, unchanged since
  1.0. A template's `package.json` is the one file in the repository that resolves
  against **npm** rather than the workspace, so those ranges decided what a
  scaffolded app actually installed — 1.3.0 for an ORM the templates had long
  since outgrown. `bun run typecheck` in a fresh app failed on
  `config/database.ts`, which imports the dialect-aware `SqliteSeederContext` that
  only exists in this repository so far.

  Releasing does not fix that on its own: the pending changesets take
  `@guren/orm` to 2.0.0, and a caret range cannot cross a major. `@guren/core` is
  on a minor line, so the same app would have installed core 1.5.0 — which depends
  on orm 2.0.0 — next to orm 1.3.0, putting two copies of the ORM in one process.

  `scripts/sync-template-deps.ts` now writes the ranges from the workspace
  versions, `version-packages` runs it immediately after `changeset version`
  (the first moment the new numbers exist), and the new `audit:template-deps`
  gate asserts they agree, so a range that falls behind fails CI on the PR that
  caused it. Because a rewritten template only reaches users inside a new
  `create-guren-app` tarball — and `create-guren-app` declares no `@guren/*`
  dependency for changesets to follow — the release path also fails if the
  templates changed without `create-guren-app` being bumped.

  None of the existing smokes could see any of this: `smoke:starter` and
  `smoke:starter:packed` both rewrite the scaffolded app's `@guren/*` dependencies
  to builds of the local checkout. The new `smoke:starter:npm` mode leaves the
  template's declared ranges alone and installs from the registry, and runs on a
  scheduled `Published Package Drift` workflow rather than in CI — it is correctly
  red between a template-facing change and the release that publishes what the
  template needs.

## 1.4.0

### Minor Changes

- c8f89d7: Console commands generated by `make:command` are now runnable.

  `make:command` wrote a class to `app/Console/Commands` that nothing ever
  registered — no template, example, or bootstrap built a `ConsoleKernel`, so the
  generated file was dead code unless the user hand-wired a kernel with no
  documentation describing how.

  Scaffolded apps now ship `src/console.ts`, which exports a `ConsoleKernel` as
  `kernel` (the name the serverless recipes already import), plus a
  `bin/console.ts` runner exposed as the `console` package script. `make:command`
  prints the import and `kernel.registerMany()` line needed to wire its output in.

  Registration stays explicit rather than globbing `app/Console/Commands`, so a
  bundled deployment resolves the same commands as a local checkout.

  The new [console commands guide](https://guren.dev/docs/guides/console) covers
  signatures, output and prompt helpers, testing a kernel with `BufferedOutput`,
  and running commands on a server or on Lambda.

- 7d18f07: Name the real cause when a database command fails, and give container-backed apps `db:up`/`db:down`

  `db:migrate` against a database that is not reachable used to report `Failed to
run database migrations: Failed query: CREATE SCHEMA IF NOT EXISTS "drizzle"` —
  the migrator's own bookkeeping statement, not anything the user wrote. The
  driver's `ECONNREFUSED` lived on the error's `cause`, which was discarded. It now
  reports `cannot connect to the database at localhost:54322 (ECONNREFUSED). Is it
running and accepting connections?`, with the host and port only so the
  connection string's credentials stay out of the log. Genuine SQL failures now
  carry the driver's message alongside the query instead of the query alone.

  Three sibling commands had the same blind spot. `db:status` caught an unreachable
  server in the branch written for "the tracker table does not exist yet", so it
  reported every migration as pending and exited 0 — indistinguishable from a
  healthy database with nothing applied; it now fails with the connection error.
  `db:reset` rethrew the driver error untouched, and a message-less
  `AggregateError` printed as a bare `ERROR` line with nothing after it. `db:seed`
  reported the failing statement without the driver's explanation of why it failed.

  Scaffolding with PostgreSQL or MySQL also writes `db:up` and `db:down` scripts
  next to the generated `docker-compose.yml`, so starting the database is
  discoverable from `package.json`. The selected driver is no longer listed in both
  `dependencies` and `devDependencies`, which made `bun install` warn about a
  duplicate dependency on the first command a new project runs.

  The AI agent harness that `agent:init` installs is updated to match: its database
  skill pointed agents at a `db:logs` script that nothing scaffolds, and handed
  container commands to SQLite projects, which have no container.

### Patch Changes

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

- 39fd7da: Stop seeding the database on boot in production.

  The scaffolded `config/app.ts` seeded whenever migrations existed, including on
  every serverless cold start. Seeding is one-shot provisioning, not part of
  booting, and the seeder loader resolves raw `db/seeders/*.ts` at runtime —
  which a self-contained bundle has no module resolver for, so a standard app
  crashed on cold start with `ERR_MODULE_NOT_FOUND`. Boot-time seeding is now a
  development convenience that is skipped when `NODE_ENV=production`; run
  seeders explicitly instead.

  Seeders cannot run inside a deployed serverless bundle at all — they are
  ordinary `.ts` modules importing the app's schema, and the function ships
  without `node_modules` or a TypeScript loader. The serverless guide now says
  so, and points at seeding from the project source or shipping the data as a
  migration.

## 1.3.0

### Minor Changes

- 7a128ed: Reload backend changes without restarting the dev server

  `dev:server` now runs `bun --hot bin/serve.ts` in both templates, so edits to
  controllers, routes, and models take effect on the next request instead of
  requiring a manual restart. In the default frontend template, adding a route
  re-runs codegen and reloads once more, then settles.

  Keep `@guren/cli` current before adding the flag to an existing project. The
  reload only settles because codegen leaves `.guren/*.gen.ts` untouched when the
  output is unchanged; older versions rewrote them on every run, and since your
  controllers import those files, each rewrite triggers the next reload.

  State held in the process does not survive a reload: the memory-backed session
  and cache stores are rebuilt empty, and module-level variables are
  reinitialized. External stores — Redis, the database — are unaffected.

  `guren doctor` now counts `dev:server` among the scripts an app is expected to
  have, so its autofix no longer adds a `dev` script that calls a missing one.

- 3d6b5d5: feat: teach scaffolds and the agent harness the docs/spec conventions

  - New apps ship with `docs/adr/0001-record-architecture-decisions.md`,
    a seed ADR explaining the frontmatter convention, `make:adr`, and the
    link checking `guren check` performs.
  - The agent harness gains `.claude/rules/docs-and-spec.md` (glob-scoped
    to docs, schema, models, controllers, routes, and pages): start
    entity work with `guren context <Entity>`, keep doc frontmatter
    current when moving files, regenerate `docs/spec/` views after
    structural changes. Existing apps receive the rule via
    `bunx guren agent:sync`. The harness `CLAUDE.md` (start-here block
    and MCP tool table, now covering `guren context <Entity>`,
    `spec:generate`, `make:adr`, and `guren_entity_context`) applies to
    new `agent:init` installs — `CLAUDE.md` is user-owned and never
    overwritten by sync.

### Patch Changes

- ac6e4ce: Add commented `OAUTH_DISCORD_*` entries to both `.env.example` templates, matching the existing GitHub/Google blocks — `guren make:auth --oauth discord` and `guren add oauth` both point users at `.env.example` for these variable names.

## 1.2.0

### Minor Changes

- 76f0465: Scaffolded apps (`default` and `api-only` blueprints) no longer route test runs into the development SQLite database. `config/database.ts`'s filename resolver now checks `NODE_ENV === 'test'` (which `bun test` sets automatically) and points at `./data/guren.test.db` instead of `./data/guren.db`, unless `DATABASE_URL` is explicitly set — which still wins.

  Also add `@guren/testing` to both templates' `devDependencies`, matching the version format already used for other `@guren/*` packages — previously a fresh scaffold had no path to `TestApp`/controller testing without a manual `bun add -d @guren/testing` first.

## 1.1.0

### Minor Changes

- a3d1191: Add `agent:init` / `agent:sync` commands and install the AI agent harness by default when scaffolding a new app.

  `agent:init` installs the harness (CLAUDE.md, `.claude/` rules, skills, agents, hooks, `.mcp.json`) into any Guren app; `create-guren-app` now runs it automatically after dependency install for every blueprint. The harness wires a verification loop via `.claude/settings.json`: the `guren context` project map is injected at session start, and `guren check` re-runs after edits to routes, controllers, models, schema, or pages, feeding failures back to the agent. `agent:sync` refreshes framework-managed files without touching user-owned `CLAUDE.md`, `.mcp.json`, or `.claude/settings.json`.

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
- 9333048: feat(create-app): add database selection, auto-install, and template version fixes
- 2c9c440: fix(create-app): add postgres and mysql2 deps for bunx compatibility
- afb6248: fix(create-app): remove @guren/cli dependency for bunx compatibility
- d098ccb: fix(create-app): bundle consola and citty for bunx Node.js compatibility
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

- f9e7441: fix(cli,create-app): fix `add resource` generating pgTable in SQLite projects
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

## 1.0.0-rc.30

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

## 1.0.0-rc.29

### Patch Changes

- a1fc6ec: Two security defaults locked in ahead of 1.0:

  - **Strict mass assignment.** When a model defines `fillable`, `create()`/`update()` now throw a `MassAssignmentException` naming any field outside the allowlist instead of silently discarding it (silent drops surfaced as NOT NULL violations far from the cause, and masked injection attempts). Use the new `forceCreate()` / `forceUpdate()` for trusted server-side data, or set `static strictFillable = false` per model to restore the old behavior. The `guarded` path is unchanged.
  - **`auth.user()` never exposes credentials.** The session guard sanitizes user records before caching or returning them: the password column, remember-token column, and the model's `static hidden` fields are stripped. Credential checks still run on the raw record internally, so login and remember-me behave exactly as before — but sharing `auth.user` into Inertia props no longer leaks `passwordHash` to the browser. Custom user providers can opt in via the new optional `UserProvider.sanitize()`. `guren add auth` now generates the User model with `static hidden = ['passwordHash', 'rememberToken']`.

## 1.0.0-rc.28

### Patch Changes

- c10691c: Three bug fixes ahead of 1.0:

  - **Nested eager loading now works at any depth** (#15). `User.with('posts.comments.author')` previously loaded two levels and silently left deeper relations unloaded when going through the query builder. `QueryBuilder` now delegates the full dotted path to `Model.loadRelationInto`, which recurses correctly.
  - **Auth context is available to middleware registered before `boot()`** (#13). The fallback auth context (apps without `options.auth`) is attached in the `Application` constructor, and the context resolves its session lazily — so `app.use(requireAuthenticated())` before `boot()` responds 401 instead of throwing, regardless of session middleware ordering.
  - **Route contracts accept array-style query strings** (#12). `?tag=a&tag=b` now reaches query schemas as `{ tag: ['a', 'b'] }` (single occurrences stay plain strings), matching the controller-side `validateQuery` behavior. Schemas that expect a plain string for a key clients may repeat should switch to `z.array(...)` or accept both.
  - **`guren add oauth` now generates code that compiles.** The scaffolded controller named its action `redirect`, shadowing the base `Controller.redirect()` helper (infinite recursion) and failing to typecheck; the route-param validator also rejected `string | undefined`. The action is now `redirectToProvider` and the validator handles missing params.

## 1.0.0-rc.27

### Patch Changes

- d3a0d2c: DX fixes from the i18n dogfooding lap:

  - **Middleware `c.header()` now reaches controller responses.** Handlers and controllers return raw `Response` objects, which bypassed Hono's response construction — headers staged via `c.header()` in upstream middleware (e.g. a locale cookie) were silently dropped. Route responses are now rebuilt through `c.newResponse()`, merging prepared headers (`Set-Cookie` appended, the handler's own headers winning otherwise).
  - **`TestApp.withHeaders()` / `withHeader()`**: send custom request headers on every request (Accept-Language, bearer tokens, …). Like `actingAs()` and `json()`, they return a new `TestApp` and compose freely.
  - **`shareInertiaProps()`** merges shared props over previously registered resolvers, so multiple providers can each contribute (auth, i18n, flash, …) without clobbering one another. `getInertiaSharedPropsResolver()` is now exported for manual composition.
  - **Docs**: global middleware must be attached in a provider's `register()` — routes mount before `boot()`, so `app.use()` from `boot()` never applies. Documented in the architecture guide (en/ja).

## 1.0.0-rc.26

### Patch Changes

- afe4bfd: Two fixes surfaced by dogfooding i18n in a real app:

  - **CSRF cookie refresh no longer wipes other cookies.** `setXsrfCookie` replaced the `Set-Cookie` header on the finalized response, silently dropping any cookie appended by inner middleware or handlers (e.g. a `locale` cookie). It now appends.
  - **`I18nConfig` accepts a `loader` option** as the i18n guide documents. Previously only `path` existed, so `MemoryLoader` (or any custom `TranslationLoader`) could not be injected into `createI18n` / `new I18nManager()`. `loader` takes precedence over `path`.

- 7fbf1de: Accept Hono middleware as a terminal route handler:

  - **`RouteHandler` now includes `(c, next)` signatures**, so any Hono `MiddlewareHandler` — including `broadcast.sseMiddleware()` and `broadcast.authMiddleware()` — can be passed directly to `router.get()` / `router.post()` as the docs show, without wrapper closures or `as Promise<Response>` casts.
  - **Responses set via `c.res` are honored**: a middleware mounted as a handler that finalizes the response through `next()` or `c.res =` no longer gets clobbered by a synthesized `204 No Content`. Plain handlers returning `undefined` still produce `204`.

## 1.0.0-rc.25

### Patch Changes

- 42c6053: Make SSE broadcasting actually reachable from clients:

  - **The SSE stream announces the connection** with a `connected` event carrying the `clientId` and any already-subscribed channels. Previously clients had no way to learn their id, and no HTTP path ever subscribed a client to a channel — SSE connections received pings but never a single broadcast event.
  - **`?channels=a,b` query subscriptions** on the SSE endpoint: requested channels are authorized against the connecting user (`sseMiddleware({ getUser })`) and subscribed before the stream starts, so a bare `EventSource` works for public channels.
  - **`POST /broadcasting/auth` subscribes as well as authorizes** when the payload includes the `clientId`, returning `{ authorized, subscribed }` per channel.
  - **Unregistered `private-`/`presence-` channels now default to deny** instead of public access — a missing channel registration no longer silently exposes a private channel.

## 1.0.0-rc.24

### Patch Changes

- 379d57e: First-class file uploads:

  - **`this.file(name)` / `this.files(name)` controller helpers** — read uploaded files from multipart requests (null/empty-safe, composes with other body reads via Hono's cached parseBody). Previously controllers had to call `this.request.parseBody()` and duck-type the result.
  - **`TestApp` accepts `FormData` bodies** — `csrf.post('/tasks/1/attachments', formData)` sends real multipart requests, so upload endpoints are finally testable.

## 1.0.0-rc.23

### Patch Changes

- 4011200: Second round of real-app (Kadai) fixes:

  - **@guren/cli codegen: inherited page props are no longer dropped.** `interface Props extends PaginatedPageProps<T> { ... }` now extracts as an intersection of the heritage clauses and the body. Previously only the body was captured — an empty-bodied extends silently degraded the page contract to `{}` (no type checking at all), and adding any own member made the inherited members vanish from the contract, rejecting valid controller props.
  - **@guren/testing: `TestApp.withCsrf()`** primes CSRF like a real browser — GETs a page, captures the session and XSRF-TOKEN cookies, and sends them (plus `X-XSRF-TOKEN`) on subsequent requests, so mutating endpoints are finally testable against apps with CSRF enabled.
  - **@guren/orm: `GUREN_QUIET_DUPLICATE_ORM=1`** silences the duplicate-copy warning for environments where two copies coexist by design (e.g. monorepo dev with src + dist).

## 1.0.0-rc.22

### Patch Changes

- 57f6f35: Fixes and features from building a real app (Kadai) on the published packages:

  - **@guren/server: entry bundles now share chunks** (tsup `splitting: true`). Each entry point previously bundled its own copy of module-level state, so `registerJob()` via the root entry and `Worker` via `./queue` used different job registries — jobs failed with "Job class not found". The same duplication affected the mail manager and queue driver globals.
  - **@guren/server: new `SyncDriver` (queue) and `LogTransport` (mail)** — the template `.env` defaults (`QUEUE_CONNECTION=sync`, `MAIL_MAILER=log`) previously named drivers that did not exist. Sync dispatch executes jobs inline with no worker process; the log transport writes full messages to server output. The `add queue` / `add mail` blueprints now honor these env vars and default to sync/log.
  - **@guren/orm: multi-relation type fix** — `findWith(id, ['a', 'b'])` and `with(['a', 'b'])` typed their results as a union of single-relation picks instead of an intersection, making relation properties inaccessible.
  - **@guren/orm: `QueryBuilder.paginate()` accepts an options object** (`{ page, perPage }`) in addition to positional arguments, matching `Model.paginate()`.

## 1.0.0-rc.21

### Patch Changes

- 8ee89bb: Quality hardening: database-matrix runtime gates, upgrade-path protection, and add-on runtime smokes:

  - **PostgreSQL golden-path gate**: the scaffold→auth→CRUD runtime smoke now also runs against PostgreSQL in CI and the release workflow (dedicated `guren_smoke` database locally so developer data is never touched), verifying dialect-aware scaffolds, `resetDatabase()`, and `migrationStatus()` on pg for every release.
  - **`guren upgrade` works for the rc channel**: previously only `--canary` was supported, leaving rc users with no tool-assisted upgrade. `guren upgrade` now aligns every `@guren/*` package to a resolved dist-tag version (default `rc`, override with `--tag`), and warns when nested duplicate `@guren` copies survive in node_modules with the exact dedupe command.
  - **Duplicate-copy runtime guard**: loading two copies of `@guren/orm` (mixed versions) now prints a loud diagnostic explaining why database access fails and how to fix it, instead of failing silently with "database has not been configured".
  - **`Mail#build()` runs automatically**: scaffolded mailables previously threw "Email must have a subject" because `send()`/`queue()` never invoked `build()` — every user following the `add mail` scaffold hit this. Found by the new add-on runtime smoke, which now dispatches the scaffolded queue job and sends the scaffolded mailable on every release.

## 1.0.0-rc.20

### Patch Changes

- bba40d6: Runtime release gate, unified drizzle-kit migrations, and richer relations:

  - **Golden-path runtime smoke**: the release workflow now boots a scaffolded app and drives login, CRUD, CSRF, and auth rejection over HTTP before publishing — the class of published-artifact-only breakage fixed in rc.20 can no longer ship.
  - **Migrations unified on drizzle-kit**: `createSqliteDatabase`/`createPostgresDatabase`/`createMySqlDatabase` now expose `resetDatabase()` and `migrationStatus()`, making `guren db:reset`, `db:fresh`, and `db:status` work out of the box (all three previously failed on scaffolded apps). `db:rollback` now explains that drizzle-kit migrations are forward-only and points to `db:reset` or a compensating forward migration; the dead flat-SQL rollback tracker was removed.
  - **Relations**: nested eager loading with dot notation (`User.with('posts.comments')` — previously documented but not implemented) and `withCount()` (`users[0].postsCount`) for hasMany/hasOne/belongsTo/morphMany. Relation declarations no longer need `typeof` guards or `as any` casts; the testing mocks now include relation registrars so model modules load cleanly under Vitest.
  - Templates export `resetDatabase`/`migrationStatus` from config/database.ts and ship `db:reset`/`db:status` scripts; relationship docs updated (EN/JA) with the clean declaration pattern and `withCount`.

## 1.0.0-rc.19

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

## 1.0.0-rc.18

### Patch Changes

- Secure-by-default hardening and AI-agent tooling:

  - `guren audit` command: validates auth/validation coverage on mutating routes, detects raw SQL, secrets, and mass assignment risks
  - `make:feature` now scaffolds auth checks by default (`--public` to opt out) and supports `--policy`
  - Authorization gate wiring, hardened auth/storage/mail/error rendering
  - Inertia asset version mismatch handling
  - drizzle-orm / drizzle-kit upgraded to 1.0.0-rc.1
  - Migration tracker SQL escaping fix and dependency vulnerability patches

## 1.0.0-rc.17

### Patch Changes

- fix(cli,create-app): fix `add resource` generating pgTable in SQLite projects

## 1.0.0-rc.16

### Patch Changes

- feat(cli): add @guren/plugin-vercel and remove legacy deploy vercel target
  fix(create-app,orm,cli): fix blog blueprint SQLite support and DX issues
  fix(create-app): comment out VITE_DEV_SERVER_URL in template .env

## 1.0.0-rc.15

### Patch Changes

- fix(create-app): bundle consola and citty for bunx Node.js compatibility

## 1.0.0-rc.14

### Patch Changes

- fix(create-app): remove @guren/cli dependency for bunx compatibility

## 1.0.0-rc.13

### Patch Changes

- fix(create-app): add postgres and mysql2 deps for bunx compatibility

## 1.0.0-rc.12

### Patch Changes

- feat(create-app): add database selection, auto-install, and template version fixes
- Updated dependencies
  - @guren/cli@1.0.0-rc.12

## 1.0.0-rc.11

### Patch Changes

- fix(ci): upgrade to Node 24 for npm OIDC trusted publishing
- Updated dependencies
  - @guren/cli@1.0.0-rc.11

## 1.0.0-rc.10

### Patch Changes

- Align all packages to rc.10.
- Updated dependencies
  - @guren/cli@1.0.0-rc.10

## 1.0.0-rc.9

### Patch Changes

- Align all packages to rc.9.
- Updated dependencies
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
  - @guren/cli@1.0.0-rc.8

## 0.2.0-alpha.7

### Patch Changes

- Fix the project created with the `create-guren-app` command so it can start successfully.

## 0.2.0-alpha.6

### Minor Changes

- Added SSR support, ORM relationships, pagination, and authentication enhancements.

## 0.1.1-alpha.5

### Patch Changes

- Ensure dev asset server resolves and serves Inertia client chunks so the scaffold works in dev.

## 0.1.1-alpha.4

### Patch Changes

- Fixed registerDevAssets to resolve the bundled Inertia client via @guren/inertia-client/app, rebuilt @guren/server, and confirmed the scaffolded app now loads without blank-screen 404s.

## 0.1.1-alpha.3

### Patch Changes

- The release build runs build:create-app so the CLI binary is bundled.

## 0.1.1-alpha.2

### Patch Changes

- Updated the scaffolded app template so new projects pull in the freshly published prerelease.

## 0.1.1-alpha.1

### Patch Changes

- Pinned dependencies to specific versions for consistency across packages

## 0.1.1-alpha.0

### Patch Changes

- 7f52ba4: Add open-source metadata, licensing, and community docs to prepare the packages for an initial public release.
- first release
