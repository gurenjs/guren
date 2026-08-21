# @guren/server

## 2.10.0

### Minor Changes

- b0625ee: Remove `ApplicationOptions.discover`. The option was accepted and silently ignored since it was introduced — nothing in `Application` ever read it, so no discovery ran and no behavior exists to migrate. This ships as a minor deliberately: it is a type-surface bug fix, not an API removal. JavaScript apps are unaffected either way, and TypeScript code passing `discover: true` now gets a compile error naming the truth instead of a silent no-op. The `AutoDiscovery` class remains available as a standalone scanner; its docs now state that registration in Guren is explicit and show how to feed scan results into the registries yourself.
- 1ebda4b: Serve Vite's content-hashed build assets (`/public/assets/*` in production) with `Cache-Control: public, max-age=31536000, immutable`. Their filenames change on every content change, so browsers can cache them forever instead of re-downloading on each visit. Files elsewhere under `public/` keep stable names and are served without a caching header, unchanged; the dev-mode route stays uncached so HMR keeps working. The prefix follows a custom `publicRoute` (e.g. `/static/*` → `/static/assets/*`).
- 532879c: A route `params` schema failure is now 422 on both handler kinds. It used to depend on how the route was handled: a controller action reported 422, while a functional typed handler given the identical schema and request reported 400.

  422 is the framework's validation status. `ValidationException` is 422, the `validateBody` / `validateQuery` / `validateParams` helpers the guides document throw it — including the guides' explicit "422 on invalid params" — and the `query` and `body` halves of these same contract options were already 422 on both paths. Only `params` was spelled 400, and only the functional path ever put that number on the wire; the controller path built a 400 response and discarded it to throw `ValidationException` instead. The status is what clients branch on: `InertiaServiceProvider` renders `ValidationException` into `form.errors`, and a 400 skips that entirely, so a form posting to a functional handler saw its params errors silently dropped.

  This ships as a minor rather than a major deliberately. The affected surface is narrow — functional typed handlers that declare a `params` schema — and the change moves behavior toward what the documentation already promises rather than away from it, so code written against the documented contract keeps working and code written against the old number was reading an inconsistency. Update any client or test asserting 400 on a params failure to expect 422.

  The response body still differs in shape between the two paths: a controller action returns `{ message, errors: { field: [...] } }` and a functional handler `{ errors: { field: "..." } }`. That difference is not specific to `params` — it already applies to `query` and `body` — and is unchanged here.

### Patch Changes

- 19310c6: Keep the SIGINT/SIGTERM/exit teardown compiling under bun-types 1.4.0, which declares `process.off` with only a `"memoryPressure"` overload and thereby shadows the generic `EventEmitter.off` the signal names relied on. Runtime behavior is unchanged.

## 2.9.0

### Minor Changes

- 4464071: ### Deprecated

  - **Class-based seeder API (`BaseSeeder` / `Seeder`, `SeederRunner`, `createSeederRunner`, `resetCalledSeeders`, and the `SeederClass` / `SeederInterface` / `SeederRunnerOptions` types)** — Write seeders with `defineSeeder` instead. Deprecated in 2.9.0, will be removed in 3.0.0. Detected by `bunx guren upgrade --check-only` as `seeder-class-convention`.

  A seeder class is not itself unsupported. `db:seed` loads seeders through `runSeeders()`, which accepts a `defineSeeder` handler, an exported `seed`/`run`/`Seeder`, or a default export — including an exported class whose prototype has a `run` method, which it constructs and calls as `run({ db })`. That last shape is deliberate: `packages/orm/tests/seeder.test.ts` covers it as "supports class-based seeders with run method".

  What `BaseSeeder` gets wrong is the signature it imposes. Its `run()` is declared to take no parameters, so it hides the one argument a seeder needs. A subclass cannot simply correct that: declaring `run(ctx: SeederContext)` fails to compile against the base (`TS2416: Target signature provides too few arguments. Expected 1 or more, but got 0`). Widening it to an optional `run(ctx?: SeederContext)` does compile, but then the subclass must handle a missing context, and that case is real: `call()`, `callOnce()`, `callMany()` and `callParallel()` construct child seeders and invoke `run()` with no arguments at all, so a parent that received a context cannot pass it down. The result is a seeder that is counted as having run while its context handling is left to chance.

  `SeederRunner` is the orchestration those classes were written for, and no Guren command reaches it. It runs a single seeder per call — a class passed in, a name registered with `register()`, or a name resolved to `<seedersPath>/<Name>.ts` defaulting to `DatabaseSeeder` — constructing it with `new` and invoking `.run()` with no context. `db:seed` does none of that; it runs every seeder in the folder.

  Nothing is removed and no existing call changes its result. This adds `@deprecated` JSDoc naming the replacement, a once-per-process runtime warning from the `BaseSeeder` and `SeederRunner` constructors, and a `seeder-class-convention` entry in the deprecation registry so `bunx guren upgrade --check-only` reports affected files. No codemod ships with it: the migration moves a class body into a handler and has to resolve how each `call()`/`callOnce()` child receives `db`, which is not a mechanical rewrite.

  These exports are re-exported from `@guren/core`, which makes them Stable under `contributing/api-stability.md`, so the deprecation policy's minimum of two minor versions applies before removal. Deprecated in 2.9.0, that permits removal from 2.11.0 onward: `removedIn` targets 3.0.0 on the assumption that 3.0.0 follows 2.11.0, which is also what keeps this removal in the same batch as `local-disk-per-object-visibility`. If 3.0.0 is cut earlier than that, this entry moves to the following major rather than being removed early.

  The sibling `BaseFactory` / `Factory` / `defineFactory` exports live in the same directory and are deliberately untouched — `make:factory` scaffolds `class …Factory extends Factory<typeof Model>`, `Factory` being the `BaseFactory` alias.

### Patch Changes

- Updated dependencies [50bdfec]
- Updated dependencies [c8489f9]
- Updated dependencies [6cbb012]
  - @guren/orm@2.6.0

## 2.8.0

### Minor Changes

- 2be4b64: Bind a route parameter by a column other than the primary key

  `bind: { id: Post }` resolves the parameter with `Post.findOrFail(value)`, so a
  `/posts/:slug` route could not use route model binding: the router looked the
  slug up as a primary key and answered 404 for every real post. The only way
  through was an adapter object (`{ findOrFail: (v) => Post.findOrFail(v, 'slug') }`)
  passed to both `bind:` and `this.model()`, which worked by accident of the
  structural type and appeared nowhere in the docs.

  The `bind` option now also accepts a `[Model, column]` tuple. The router calls
  `Post.findOrFail(value, column)` and `this.model(Post)` returns that record, so
  the class-only form and the tuple form read the same in the controller:

  ```ts
  router.get('/posts/:id',   { bind: { id: Post } },              [PostController, 'show'])
  router.get('/posts/:slug', { bind: { slug: [Post, 'slug'] } },  [PostController, 'show'])

  async show() {
    const post = this.model(Post)
  }
  ```

  Router-level `router.bind(param, ...)` accepts the same tuple, and its model
  bindings — class or tuple — now feed `this.model(Post)` too. Values from
  `router.bind()` still arrive as positional arguments after the context, in
  path-parameter order; that is the only channel for a custom resolver function,
  which has no model class to look the record up by. Because `this.model()` is
  keyed by the model class, a route's own `bind` wins whenever both levels would
  write the same class — a same-param override, or two params bound to one
  model. The router-level binding still resolves and still fills its positional
  slot, so a custom resolver's side effects are never skipped.

  Neither channel ever landed on the Hono context: the routing guide told
  readers to use `this.ctx.get('post')`, which has always been `undefined`. The
  English and Japanese guides, the agent harness rules, and the `guren context`
  API digest now describe the two channels that exist, including the one limit
  `router.bind()` has always had — bindings resolve for controller-action routes,
  never for inline handlers, which take Hono's `(ctx, next)`. A router test pins
  each behavior, so the docs cannot drift from the implementation unnoticed
  again.

  `this.model(Post)` is also typed as the model's record now. Its return type
  was read off `findOrFail`, which is generic in `this`, so `ReturnType` widened
  it to the base row (`Record<string, unknown>`) and `post.id` came back
  `unknown` — the docs claimed `PostRecord` all along. The record type now comes
  from the `recordType` marker `defineModel()` sets; anything without a usable
  marker — including an adapter whose `recordType` names something other than a
  record — keeps the previous fallback.

  `BindableModel` and the new `RouteModelBinding` type are exported from
  `@guren/core` for code that builds `bind` maps outside a route call.

### Patch Changes

- 0fd78a8: Publish the application container so `Job.make()` works

  `Job.make()` and the exported `resolve()` read the process-wide container that
  `setContainer()` fills in, but nothing in the framework ever called it. Every
  job that resolved a service — `this.make('mail')` inside `handle()`, the way a
  controller resolves one — therefore threw `Container not initialized. Call
setContainer() first.` the moment a driver ran it, whether that was `SyncDriver`
  in-process or the worker behind `guren queue:work`.

  `Application` now publishes its own container, so anything reaching for the
  global finds the app's bindings.

  It publishes at construction rather than in `boot()`: `guren queue:work`
  bootstraps the app only far enough to read the queue driver, and an entry that
  merely exports the application — with no `ready` or `bootstrap` export — is
  accepted there and never booted. A job dispatched from module scope is in the
  same position. Bindings a service provider registers still only exist after
  `boot()`, as before; construction publishes the container, not its contents.

  Publishing is the constructor's last step, so an application that fails to
  build leaves the previous one's container in place instead of replacing it with
  a half-built one. Otherwise the most recently constructed application wins,
  which is what `bun --hot` needs — a reloaded entry replaces the stale container
  rather than being ignored.

- Updated dependencies [9e1ce65]
- Updated dependencies [7251560]
- Updated dependencies [866919c]
- Updated dependencies [32e03dd]
- Updated dependencies [39b17e7]
  - @guren/orm@2.5.0

## 2.7.0

### Minor Changes

- 2b98e24: Let the S3 driver talk to endpoints without object ACLs, and scaffold a switchable disk

  `S3Driver` sent `x-amz-acl` on every `PutObject` and reached for
  `PutObjectAcl` / `GetObjectAcl` for visibility, which is correct for AWS S3
  and wrong for several S3-compatible endpoints. Cloudflare R2 documents both
  the header and the ACL operations as unsupported — access there is decided
  per bucket — and MinIO deployments vary. The storage guide has recommended
  `driver: 's3'` against R2 for a while, so this affected a documented path.

  `S3DriverOptions.acl` (default `true`, so nothing changes for AWS) turns the
  header off. With `acl: false` visibility becomes a property of the disk:
  `getVisibility()` reports the configured `visibility`, and `put({ visibility })`
  or `setVisibility()` throw when asked for the other value instead of silently
  dropping it — a `setVisibility(path, 'private')` that does nothing on a public
  bucket is a leak that looks like success.

  The `StorageDriver` contract now states what the visibility methods do,
  which four drivers had been answering three different ways: a visibility
  call throws when the file does not exist, and a backend without per-object
  visibility reports the disk's configured value and refuses the other one
  instead of accepting a request it cannot carry out. `R2Driver` and the new
  `acl: false` path follow it from the start.

  **Deprecated, not changed:** `LocalDriver` has always accepted per-object
  visibility requests and done nothing — `put({ visibility })` and
  `setVisibility()` against a disk's other value, and either visibility method
  against a file that does not exist. It now warns once per process for each
  and keeps its current behaviour; these become errors in 3.0.0. What makes a
  local file reachable is the disk root and whatever serves it, not a flag on
  one file, so those calls were never carried out, they only looked like they
  were.

  To get ahead of it, declare the visibility on the disk rather than the call:
  the scaffolded `public` disk now carries `visibility: 'public'`, and files
  that must not be reachable belong on a disk that is not served.
  `bunx guren upgrade --check-only` lists the call sites.

  Separately, `guren add storage` now scaffolds a disk map selected by
  `STORAGE_DISK`, so an app declares its disks once and picks one per
  environment. The generated provider validates the name at boot: an unknown
  one is accepted by `createStorageManager` and only fails when a disk is first
  resolved, which can be inside a queued job.

## 2.6.0

### Minor Changes

- 1f815fd: Routes can declare their response shape by naming the Resource that builds it, and the generated API client types `json()` from it.

  `RouteContractOptions` gains a `resource` field: a Resource class, a one-element array (a collection), or a plain object of either (an envelope) — `resource: { data: [PostResource] }` mirrors `this.json({ data: PostResource.collection(posts) })`. Unlike `output`, nothing runs at request time; the hint is purely a type-level declaration, so the response shape lives in one place (the Resource's `toArray()` type) instead of being restated in Zod.

  `definitions()` serializes the hint to class names (`RouteDefinition.resource`), and `guren codegen` resolves those against the Resource classes it already extracts into `.guren/data.gen.ts`, emitting the assembled shape (`{ data: Data.Post[] }`) as the route's `response` type — the same slot an `output` schema fills, and `output` still wins when both are declared. A hint naming a Resource class codegen cannot find warns and leaves that route's response untyped rather than claiming a shape the server does not send. `generateApiClientTypes` returns those warnings (`{ outputPath, warnings }`, the same contract as `generateOpenApiSpec`), and the MCP `guren_codegen` tool forwards them in its payload alongside `generated`/`skipped`.

  The blog starter's `posts.search` route now declares `resource: { data: [PostResource] }`, so its search page reads `json()` typed instead of asserting the shape at the call site.

### Patch Changes

- Updated dependencies [7b34556]
- Updated dependencies [b7b2b09]
  - @guren/orm@2.4.0

## 2.5.0

### Minor Changes

- 684db66: Add a public `Application.stop()` to undo `listen()`

  `listen()` had no counterpart. It bound a socket, took the process-wide active
  server slot, started a managed Vite dev server, and registered SIGINT/SIGTERM/
  exit teardown — and the only path back out was the module-private
  `stopActiveBunServer()`, which an app could reach by signalling the process or
  by calling `listen()` again to replace the server, but never to simply stop.
  An app could be started programmatically but only stopped by ending the program.

  `await app.stop()` now closes the socket, clears the instance's server and the
  managed Vite dev server, and detaches the teardown handlers. It takes the same
  `closeActiveConnections` flag Bun's own `stop()` does, defaulting to `false`:
  a caller reaching for a public stop is usually shutting down deliberately,
  whereas the hot-reload path inside `listen()` keeps forcing the close, since a
  reload must not wait on the server it is replacing. Calling it when nothing is
  listening, or calling it twice, is a no-op.

  Vite goes down with it. `listen()` is what started the dev server, and
  `listen()`'s own bind-failure path already closes the one it started; stopping
  the application while leaving the asset server up would strand it, and its
  published environment variables, in a process with no application server. That
  close is best-effort on the same terms as every other shutdown path — bounded by
  `GUREN_VITE_CLOSE_TIMEOUT_MS`, and a dev server that overruns the bound is warned
  about and abandoned rather than holding `stop()` open. `GUREN_INERTIA_ENTRY` is
  now unpublished alongside the other managed variables, but only when it still
  holds the entry `listen()` published; an app that set its own is left alone.

  The global active-server slot is cleared only when it still points at this
  instance's server, mirroring the ownership check `closeViteDevServer()` already
  makes. A second `listen()` anywhere in the process force-stops the previous
  server and takes the slot over, so an app that stopped afterwards would
  otherwise clear a live server's teardown out from under it.

  `app.address` follows from that: it reports `undefined` once stopped, and the
  new address after a restart. Its documentation already treated a stop the
  framework can see as clearing the address, and `stop()` is now one of those —
  what it still cannot see is a caller reaching past the framework to the Bun
  server's own `stop()`.

  The teardown handlers are detached rather than forgotten, on both halves.
  Registration was guarded by a flag that only ever went `true`, so a close that
  merely reset the flag left the handlers attached while claiming otherwise, and
  the next `listen()` piled on another set. `stop()` now removes them and
  `listen()` re-attaches exactly one set, which is what makes an app restartable
  in a single process — a restarted app with no handlers is killed by SIGTERM's
  default disposition instead of shutting down through its own teardown.

  The Vite dev server's handlers had the same defect and are fixed with it, which
  matters more than the count: a leaked set keeps its own signal handler, and
  because handlers run in registration order a stale one could call `process.exit()`
  ahead of the live server's shutdown. Those handlers also captured the
  `Application`, so each leaked set pinned an entire app — container, routes and
  providers included. Both registrars now share one helper that attaches the
  SIGINT/SIGTERM/exit trio and returns the disposer for it, so neither can drift
  back to a memo that disagrees with what is actually attached.

  The starter templates are unchanged: they resolve `@guren/*` from npm and
  cannot call this until the release that ships it.

- dbd2e64: `authorizeResourceMiddleware` now fails closed on HTTP methods outside its built-in mapping

  Previously an unknown verb (e.g. a custom `PURGE` route registered via `router.on()`) fell through to the `view` ability, so a user with only view permission passed the gate in front of a handler that may mutate state. Unknown methods are now denied with a 403 (`AuthorizationException`).

  - The built-in mapping is now explicit: GET/HEAD/QUERY → `view` (QUERY is safe per RFC 10008, matching CSRF and `guren audit` classifications), POST → `create`, PUT/PATCH → `update`, DELETE → `delete`. Behavior for these methods is unchanged.
  - Custom verbs can opt in via the new `abilityFor` option (`AuthorizeResourceOptions`): return an ability name for a method, or `undefined` to fall back to the built-in mapping.

  ```ts
  authorizeResourceMiddleware(getPost, {
    abilityFor: (method) => (method === "PURGE" ? "delete" : undefined),
  });
  ```

  If you relied on custom verbs passing as `view` checks, add an `abilityFor` mapping for them.

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

- 9452c71: Fix `Application` lifecycle races that could kill a live server or orphan one

  `listen()` and `stop()` tracked the running server across several independent
  pieces of state, and neither checked whether that state still described the
  server it was acting on by the time it resumed from an `await`. Three ways that
  went wrong:

  **A stopped app could close a Vite dev server a newer app adopted.** On a
  `bun --hot` reload the next `listen()` reuses the dev server the previous run
  left listening, so both applications held the same server object. `stop()` on
  the earlier one saw its own reference set and closed it — taking the asset
  server, its port, and its published `VITE_DEV_SERVER_URL` out from under the
  app that was serving from it. Comparing references cannot catch this: it is the
  same object. The active-server slot now names one owner at a time, adoption
  transfers that ownership along with the process teardown handlers, and only the
  owner may close.

  **A `stop()` concurrent with a `listen()` could orphan the newly bound socket.**
  A graceful `stop()` waits on in-flight requests; a `listen()` arriving in that
  window force-stopped the old server, bound a new one, and reused the teardown
  registration. The resuming `stop()` then cleared the instance's server handle
  and detached the handlers — leaving the new socket live with no way to reach it
  and no signal handling. `stop()` now returns without touching anything once it
  sees a `listen()` has superseded it.

  **A late cleanup could clear the process-wide slot out from under a live
  server.** `listen()`'s force-stop of the previous server cleared the slot
  unconditionally when it finished, even if another `listen()` had already pointed
  it at a server of its own. That slot is what the SIGINT/SIGTERM/exit teardown
  reads, so wiping it meant the surviving socket was never closed at shutdown. The
  clear is now conditional on the slot still holding the server that was stopped —
  and the Vite restart cleanup guards its slot, and the published env vars that
  travel with it, the same way.

  **Two `listen()` calls racing could strand what the loser started.** With
  nothing bound yet, both calls pass the entry force-stop, both bind, and the
  later assignment overwrote the instance handle — leaving the earlier socket live
  with nothing left holding it. A displaced server is now stopped instead of
  dropped, and a fresh Vite dev server displaced from the slot the same way is
  closed instead of stranded on its port.

  Also bounds the server `stop()` itself, mirroring the existing Vite close bound:
  a graceful stop that never finishes draining no longer holds shutdown open
  forever. The bound defaults to 5s and is configurable through
  `GUREN_BUN_STOP_TIMEOUT_MS`. A `stop` or `close` that throws synchronously is
  contained like one that rejects, instead of escaping the shutdown path.

- Updated dependencies [dd9a5df]
  - @guren/orm@2.3.0

## 2.4.0

### Minor Changes

- 0e072be: Expose the bound address on the application as `app.address`

  `Application.listen()` returns `{ port, hostname, url }`, but the instance kept
  only its private Bun server, so the address was available in exactly one place:
  whatever received `listen()`'s return value. Anything else that needs it — an
  OpenAPI `servers` entry, an absolute URL builder, a health report — had to have
  it threaded in from the entrypoint. The example API did this with a module-local
  variable and an exported setter re-exported through two files so that
  `bin/serve.ts` could push the address back down into the app that had just
  produced it. Every app mounting OpenAPI docs would have hand-rolled the same
  wiring.

  `app.address` now returns the same `ListenAddress` `listen()` returned, and
  `undefined` before `listen()`. It reads a value stored at bind time rather than
  re-deriving one from the live server, because `listen()` resolves the port
  through a fallback the socket no longer carries; the wildcard-host mapping
  (`0.0.0.0` → `127.0.0.1`, `::` → `::1`) stays in the single helper `listen()`
  already uses. `ListenAddress`'s fields are now `readonly`, since the object
  `listen()` hands back is the one every later reader sees.

  It reverts to `undefined` when the server is superseded or torn down through
  the framework — a later `listen()`, including one whose rebind fails, and the
  process-exit teardown. A server stopped by calling `stop()` on the Bun server
  directly leaves no signal behind, so the accessor keeps reporting its address:
  it answers "where did `listen()` put this app", not "is this app healthy".

  This does not replace passing a function to `@guren/openapi`'s `servers`
  option. Late resolution is what lets the document name an address the app did
  not have at mount time, and a function is the only form available when mounting
  against a plain Hono instance rather than an `Application`.

- cb46086: Return the bound address from `Application.listen()`, and move the busy-port walk into it

  `listen()` called `Bun.serve({ port })` and discarded `server.port`, returning
  `Promise<void>`. The framework knew the port it had bound and threw it away, so
  the only way to find out was to scrape the dev banner — ANSI-coloured prose
  written for humans. `listen()` now returns `{ port, hostname, url }`, read off
  the running server rather than echoed back from the request.

  That mattered because the port asked for and the port bound are routinely
  different numbers. The walk past a busy port lived in four copies of
  application code (`bin/serve.ts` in both starter templates, the blog example,
  and the docs site), each wrapping the framework call that should have owned it.
  Copies drift, and none of them could report where the app ended up. The walk now
  lives in `listen()` behind `portFallback`: `true` walks the next 20 ports,
  `false` fails fast. Left unset it walks outside production, which is what the
  loops it replaces did. Moving the walk inside also makes it dramatically
  cheaper — a retry used to re-enter `listen()` and restart the managed Vite dev
  server (~600ms per busy port); it is now a bare re-bind.

  A bind that gives up now shuts the managed Vite dev server down on its way out.
  `listen()` starts Vite before anything tries to bind, so an exhausted walk — or
  a strict-port failure, which is precisely the case automated callers _handle_
  rather than exit on — used to leave an asset server and its published
  environment variables running in a process with no application server.

  `GUREN_STRICT_PORT=1` forces fail-fast from outside the app. This is the case the
  walk actively harms: a smoke script, a Playwright `webServer`, or a CI job that
  pins a port needs to know the app answering is the one it started. Walking past a
  busy port makes that failure silent and inverted — the run goes green against
  somebody else's server. `bun run dev` keeps the convenience by default.

  `PORT=0` also works now. `Number.parseInt(process.env.PORT ?? '', 10) || 3333`
  turned 0 into 3333, so "let the OS pick a free port and tell me which" could not
  be expressed — and it is the natural way to run tests in parallel. The walk is
  skipped for port 0, which has nothing to recover from and would otherwise march
  into the privileged range.

  The starter templates keep their own loop for now: they resolve `@guren/*` from
  npm, so they cannot use a `listen()` option until the release that ships it.
  They do honour `GUREN_STRICT_PORT` and parse `PORT=0` correctly, which needs no
  new API.

### Patch Changes

- 730358f: Keep the dev server listening across `bun --hot` reloads by reusing the managed Vite dev server

  Editing a backend file in a scaffolded app — or running `guren add resource` /
  `guren add auth`, which edit several — killed the dev server silently. `bun
--hot` re-runs the entrypoint, and the new `listen()` stopped the previous Bun
  server first, then awaited the previous Vite dev server's `close()`. Vite
  waits for every open connection, and a browser tab holding its HMR socket can
  keep that wait alive indefinitely — so the process stayed up with no HTTP
  listener at all, no error printed, and every checkpoint URL dead until a
  manual restart.

  `listen()` now adopts the still-listening Vite dev server a previous run left
  on `globalThis` (which `bun --hot` preserves) instead of tearing it down. The
  browser keeps its HMR socket, the reload skips the `close()` wait entirely,
  and the Bun listener re-binds immediately. Explicit `vite` options still force
  a restart — the running server was built from the previous call's options.

  Two failure paths harden alongside: the previous Bun server is force-closed
  (a dev reload must not wait on in-flight requests — an open SSE stream used to
  be able to hang it the same way), and the paths that do close Vite abandon a
  `close()` that has not resolved within `GUREN_VITE_CLOSE_TIMEOUT_MS` (default 5000) with a loud warning instead of hanging the process.

- 10dddc8: Stop linking the raw dev stylesheet when a Vite dev server owns the entry

  In development the Inertia document linked `/resources/css/app.css` — the
  _source_ file, served raw by the app server. With Tailwind in it (every
  scaffolded app), the browser then requests the bare `@import 'tailwindcss'`
  specifier as a relative URL, 404s, and logs a MIME-type console error on every
  page load. The link contributed nothing: the compiled CSS already arrives
  through Vite's module graph via the `app.tsx` import.

  The document renderer now drops exactly that dev-default path when the script
  entry is served from a dev server (an absolute http(s) URL). A per-call
  `styles` option is an explicit choice and is never filtered; other
  env-configured hrefs are left alone; fallback mode (no Vite; the entry served
  same-origin) keeps the link — there the raw file is the only styling — and
  production manifest-derived links are untouched.

- 5970497: Fix the `FormRequest` JSDoc example that documented a no-op authorization gate

  `AuthContext.user()` is async, but `FormRequest`'s `protected user()` was
  declared `(): unknown` and returned its result unawaited. The class JSDoc built
  its `authorize()` example on that:

  ```ts
  authorize() {
    return this.user() !== null   // a pending promise — always true
  }
  ```

  An app that copied it authorized every request, including logged-out ones. The
  precondition is an attached auth context, which is the normal case:
  `Application` attaches a fallback one in its constructor even when the app
  configures no `options.auth`. The `unknown` return type kept `tsc` quiet.

  `user()` is now `protected async user<TUser>(): Promise<TUser | null>` and the
  example awaits it. `authorize()` already accepted `boolean | Promise<boolean>`
  and `handle()` already awaited it, so nothing else moves — for callers that
  await, runtime behavior is identical before and after.

  `handle()`'s JSDoc also claimed it was `@internal Called by
Controller.validate()`. That method does not exist and nothing in the framework
  calls `handle()`, so it now documents the real entry point:
  `await new StorePostRequest().handle(this.ctx)`.

  ### Note for subclasses that override `user()`

  The new signature is source-incompatible for a subclass that **overrides** the
  helper — `protected user(): unknown` no longer satisfies the base declaration.
  It is `protected` on a deprecated class, so this is not public API surface, and
  subclasses that only _call_ `user()` are unaffected.

  Migration: change an override to `protected async user<TUser = unknown>():
Promise<TUser | null>`. Separately, a subclass that copied the old
  `this.user() !== null` line keeps compiling and keeps returning true — a
  promise is still legally `!== null` — so rewrite it as
  `(await this.user()) !== null`.

- 8bc311d: Keep the query string in the default Inertia page url

  `Controller.inertia()` resolved the page `url` from `ctx.req.path`, which is
  the pathname only — so `usePage().url` never saw the current query
  parameters. Anything deriving state from the query (pagination, filters,
  sort order) silently lost it on every visit, and navigation components that
  propagate the active query onto their links emitted bare paths. The Inertia
  protocol expects `url` to include the query string (`"/posts?page=1"`).

  The default now lives in the `inertia()` engine itself: when `options.url`
  is absent, the page url is derived from `options.request` as the pathname
  plus the query string, kept relative as the protocol expects. This covers
  every caller that hands the engine a request — `Controller.inertia()` and
  direct `inertia()` calls alike — and an explicit `options.url` still
  overrides it. The `@guren/testing` controller mock mirrors the same
  default. On a version-mismatch 409, `X-Inertia-Location` now falls back to
  the absolute request URL when no `url` override is given, matching what the
  client does with that header.

  The `make:auth` scaffolds and the create-app templates no longer pass
  `url: this.request.path` — they rely on the default, so generated apps get
  the query-preserving value instead of re-introducing the lossy form.

- e38ac75: Harden the GCM tag length, the debug-page production gate, and SSE client ids

  Three defence-in-depth fixes from the framework security review. None closes a
  confirmed exploit on a shipped code path; each removes a way one could open.

  - **GCM authentication tags are pinned to 16 bytes.** `setAuthTag()` adopts
    whatever length it is handed, and a truncated tag was measurably accepted: a
    payload rewritten with the first 4 bytes of a real tag decrypted successfully,
    dropping forgery resistance from 2^128 to 2^32. Both `createCipheriv` and
    `createDecipheriv` now pass `authTagLength: 16`, and a short tag is rejected
    before any key is tried. Everything the `Encrypter` writes already used the
    full tag, so no existing payload is affected.

  - **`debugErrorMiddleware`'s production gate no longer uses an optional chain.**
    The page renders the stack trace, the request, and the process environment,
    and this read is its only guard. The deploy plugins settle it at bundle time
    with `--define 'process.env.NODE_ENV="production"'`, which substitutes one
    exact expression — the optional chain was not it, so on hosts where platform
    vars never reach the process environment the gate answered "not production".
    A source-level test pins the form, matching the MCP and docs-viewer gates.

  - **SSE client ids are unguessable, and a stream now records its owner.**
    `POST /broadcasting/auth` takes a `clientId` from the request body, so
    authorizing a channel attached it to whatever stream that id named. Ids were
    `Date.now()` plus a `Math.random()` suffix; they are now 16 random bytes from
    `randomHex`, which is the control that actually stops an attach against
    someone else's stream.

    The ownership check is defence in depth on top of that: the endpoint refuses
    to attach a channel to a stream whose recorded owner differs from the caller.
    Ownership is read from the conventional `id`/`sub`/`userId` field of whatever
    `getUser` returns, and a stream stays attachable when no owner could be
    resolved — both because a stream opened before sign-in has to stay attachable
    for authorize-after-login, and because the two cases are indistinguishable.
    An app whose user objects carry none of those fields gets the unguessable id
    and no second layer.

- e38ac75: Fix the health middleware returning an empty 204, and never-expiring Redis API tokens reading as expired

  Two independent bugs, both fail-safe (a broken read, not an exposure):

  - `HealthManager.middleware()` built its JSON response with `ctx.json(...)` but
    never returned or assigned it, so the router saw an unfinalized context and
    synthesized an empty `204` — the documented `router.get('/health',
health.middleware())` returned no report at all. It now finalizes the context
    by assigning `ctx.res`, preserving the `200`/`503` status.

  - `RedisApiTokenStore` serializes a never-expiring token's `expiresAt` as `''`
    (a Redis hash has no null). On read, `toOptionalExpiry('')` degraded the empty
    string to the epoch rather than treating it as absent, so every non-expiring
    token in Redis was rejected as expired. The empty string now maps to "no
    expiry"; a genuinely unparseable value still degrades to expired.

- dbbc0a2: Deliver Inertia validation errors on apps without a session

  Sessions only mount when `createApp({ auth })` is configured, and the Inertia
  validation renderer flashed errors to the session guarded by `if (session)` —
  so on a fresh scaffold (no auth yet) every validation failure redirected back
  with the errors silently dropped. The form appeared to do nothing: no
  navigation, no messages, nothing in `form.errors`. The tutorial's Part 1
  checkpoint ("Title is required." appears) was impossible to pass before Part 2
  installed authentication.

  Without a session, the flattened errors now ride across the one redirect in a
  short-lived HttpOnly cookie (display-only data, no store required, works on
  every runtime), and the shared-props resolver reads them from there into the
  same `errors` prop. Reading consumes the flash: a cleanup middleware expires
  the cookie on the render that consumed it — and only then, so intermediate
  hops (a trailing-slash redirect, an auth bounce) don't burn the errors before
  a page shows them, matching session-flash semantics. Fields too large for the
  ~4KB cookie cap are skipped individually so the rest still arrive. Apps with
  a session keep the existing flash path unchanged.

- Updated dependencies [e38ac75]
- Updated dependencies [5e38d18]
  - @guren/orm@2.2.2

## 2.3.0

### Minor Changes

- e87d053: Add `TestApp.fromApp(app)` and make `Application.boot()` idempotent

  Testing against the real application required
  `await app.boot(); TestApp.fromFetch((request) => app.fetch(request))` — and
  the arrow wrapper is load-bearing, because an unbound `app.fetch` reference
  throws (`Application.fetch` reads instance state). `TestApp.fromApp(app)`
  boots the app and binds fetch, removing both the boilerplate and the footgun.

  `Application.boot()` now reuses its first call, so booting twice is a no-op
  rather than mounting security middleware and routes a second time. This also
  covers two callers booting concurrently, which the previous code could not:
  each saw an unbooted app and mounted everything again. A boot that throws is
  not remembered, so a later call attempts boot again — it resumes on a
  partially mounted app rather than starting clean, which is how the Cloudflare
  Workers handler has always treated it.

  This is a behavior change to a public method: a second `boot()` used to
  duplicate the middleware chain and now does nothing.

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

- 72bd945: Anchor the asset path containment checks on a separator

  The dev transpiler route, the Inertia client route, and the production Inertia
  client handler resolved a request path and then checked containment with a bare
  `startsWith(dir)`. A sibling directory whose name extends the base passes that —
  `resources/js` against `resources/jsonfixtures`. All three now use
  `startsWith(dir + sep)`, matching the check `public-assets.ts` already carried
  for the same reason.

  The check is reachable because the request remainder is taken with
  `ctx.req.path.slice(base.length)`, so a doubled slash (`/vendor//var/...`) leaves
  an absolute remainder that `resolve()` returns verbatim; `../` and `%2e%2e` are
  normalized away by URL parsing before the handler runs. No default-scaffolded app
  has a sibling directory that would escape, so this closes the check rather than a
  live hole.

- eebd978: Make asset path containment survive symlinks

  `resolve()` collapses `..` but does not follow symlinks, while every reader
  downstream of these checks does — `Bun.file().text()`, `.arrayBuffer()`, and
  `new Response(file)`. So a request for `resources/js/link/secret.txt`, where
  `link` points out of the tree, resolved to a path lexically under the root,
  passed the containment check, and was served from wherever the link led. The
  dev transpiler route, both Inertia client routes, and the root public asset
  middleware were all affected.

  Containment is now judged on canonicalized paths, once the target is known to
  exist — the point at which it can be canonicalized, and, for the dev
  transpiler, the point at which extension probing has settled which file is
  actually read. Both sides are canonicalized, not just the candidate: a root
  reached through a symlink is routine (workspace and pnpm layouts, containers,
  macOS `/var`), and canonicalizing only the candidate would reject every asset
  such an app serves.

  The four call sites now share `isPathWithin` / `isRealPathWithin`, so this
  decision lives in one place instead of four copies of a `startsWith`.

  The configured entry points are deliberately exempt: they come from
  configuration rather than from the request, and a package layout may
  legitimately have the resolved module symlinked out of its own directory.

  Closing this needs local write access inside the project, so it is defense in
  depth rather than a live hole. It is a behavior change all the same: an asset
  deliberately symlinked out of `public/` is no longer served through the
  root-level public asset route. Copy the file into the tree instead.

  The scope is the framework's own handlers. `/public/*` and `/resources/css/*`
  are delegated to Hono's `serveStatic`, whose path handling leaves no lexical
  escape but which follows symlinks out of its root by design, as nginx and
  `express.static` do. So the same linked file that the root-level public asset
  route now refuses still serves under `/public/*`. Guren does not enforce
  symlink containment on the delegated routes; a deployment that must not follow
  symlinks out of `public/` should not rely on `/public/*` for that.

  Hono's `onFound` hook cannot close this — it runs after the content has been
  read and cannot reject — so guarding the delegated routes would mean either
  mirroring Hono's own path resolution in a second place or reimplementing static
  serving. Both were judged worse than the gap, and the gap is left explicit
  rather than papered over.

- 72bd945: Write the dev-endpoint gates in the form the deploy bundlers substitute

  `isMcpEndpointEnabled()` and `isDocsViewerEnabled()` read
  `process.env?.NODE_ENV` and `process.env?.GUREN_*`. The deploy plugins settle
  these branches at build time with `--define 'process.env.NODE_ENV="production"'`,
  which targets `process.env.NODE_ENV` — the optional-chained form is a different
  expression and was never substituted. `@guren/plugin-cloudflare`'s own comment
  records why that matters: wrangler `vars` are not guaranteed to reach
  `process.env` before the app's module graph evaluates, so a module-scope
  `NODE_ENV` branch has to be settled by the bundler.

  Both gates now use the plain form behind the existing `typeof process` guard,
  with a comment recording why `?.` must not come back. Deployed apps were already
  closed for other reasons — each plugin also sets `NODE_ENV=production` at
  runtime, and nothing sets `GUREN_MCP`/`GUREN_DOCS` — but the mechanism the
  plugins rely on now actually applies.

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

- f43684c: Serve the built Inertia client in production, not its TypeScript sources

  `configureInertiaAssets()` located the vendored client by resolving
  `@guren/inertia-client/app` and taking `dirname()` of whatever came back. That
  subpath is not a stable anchor: a tsconfig `paths` entry mapping
  `@guren/inertia-client/*` at the package's `src/` — which Bun applies to
  runtime resolution, `import.meta.resolve` and `require.resolve` alike —
  redirects it to `src/app.tsx`. The production route then looked for
  `src/app.js`, which does not exist, and 404'd; every `chunk-*.js` the entry
  imports resolved against `src/` too, so the fallback of "the entry at least
  loads" was not available either.

  Resolution is now anchored on `@guren/inertia-client/package.json` — a subpath
  no `paths` entry shadows, since a mapping at `src/` misses and falls back to
  real package resolution — and the client directory is that package root's
  `dist/`. The path is derived from the package rather than from whichever file a
  specifier happened to reach.

  This bites wherever such a `paths` mapping is in scope, which is this
  repository: the reference app, the smokes, and the E2E runs all serve
  production assets through it. An app that installs `@guren/*` from npm has no
  `@guren/*` mapping, so its resolution already landed on `dist/app.js` and its
  behavior is unchanged.

  The resolution is now `resolveInertiaClientDir()`, exported so it can be
  asserted directly. Its previous form lived inline in `configureInertiaAssets()`,
  where no test could observe which directory it had chosen.

- 72bd945: Refuse requests the loopback guard cannot place, instead of allowing them

  `createLoopbackGuard` protects `/_guren/mcp` and `/_guren/docs`, and it has to
  stop two classes of caller: browser pages, rejected unless the `Origin` is
  loopback, and non-browser clients, rejected unless the socket peer is. Both
  checks were skip-on-absence — `clientAddress()` returned `undefined` when the
  runtime exposes no `server.requestIP`, and each check only refused when its
  signal was present. A client that sends no `Origin` (curl, any MCP client) on a
  runtime that reports no peer therefore passed both. That degradation is real on
  every non-Bun host and on `@guren/plugin-vercel`, which calls `app.fetch(request)`
  with no environment even though Bun is present.

  The peer check is now positive: a loopback peer allows, a peer that is present
  and not loopback is refused as a remote request, and a peer the runtime never
  reported is refused as one the guard cannot vouch for. The two denials say
  different things on purpose. `bun run dev` is unaffected — `Application.listen()`
  passes `{ server }` into `Bun.serve`, so the peer resolves on every request.

  For a host that genuinely cannot report a peer, `GUREN_ALLOW_UNVERIFIED_PEER=1`
  opts out, and the refusal names it.

  A loopback `Origin` deliberately does not satisfy the peer check. `Origin` is a
  negative filter — it attests that a _browser_ saw a cross-site request — and any
  non-browser client sets it with one flag, so accepting it as proof of locality
  would leave the hole open to `curl -H 'Origin: http://localhost'`.

  What the guard checks is the connection, not the caller: a reverse proxy,
  container port publish, or tunnel that terminates locally presents a loopback
  peer, so traffic behind it is accepted. The guides now say so, and say not to put
  a tunnel in front of a dev server running with `GUREN_MCP=1`.

- e22b10f: Report why the MCP codegen tool skipped an artifact

  `guren_codegen` filed every empty generator result under `"nothing to generate"`.
  That is right for an app with no page components, and wrong for the one case where
  a generator declines on purpose: the pages manifest is not written into an app that
  cannot compile one. An agent that just wrote a page component and asked for codegen
  was told there was nothing to describe. Generators can now carry a sentence with the
  empty result, and the tool reports it in place of the generic reason.

- 72bd945: Apply the security defaults to every response, including raw ones

  Two independent gaps meant the framework's own asset responses carried neither
  host authorization nor a single security header.

  `Application.boot()` mounted the security defaults, but the scaffolded templates
  call `autoConfigureInertiaAssets(app, …)` at module scope in `src/main.ts` —
  before `bootstrap()` awaits `boot()`. Hono composes matched handlers in
  registration order, so those asset routes ran ahead of the `use('*')` middleware
  and answered without ever entering it. With the template's development host
  authorization (`allowedHosts: ['localhost:*', '127.0.0.1:*']`) and `bin/serve.ts`
  binding `0.0.0.0`, `GET /` from a LAN peer was refused with 403 while
  `GET /resources/js/pages/Home.tsx` returned 200. The same ordering applied in
  production to `/public/*` and the root asset catch-all.

  `mountSecurityDefaults()` now runs in the `Application` constructor, which is the
  one position an application cannot register in front of. A double `boot()` no
  longer double-mounts the middleware either.

  Separately, `createSecurityHeaders`, `createForceHttpsMiddleware` and
  `createCspMiddleware` wrote their headers with `ctx.header(...)` before
  `await next()`. Hono keeps those in prepared headers and merges them only when
  the handler answers through the context; a handler returning a raw
  `new Response(...)` replaces `ctx.res` outright and drops them — which is every
  asset response the framework serves, and any application controller that returns
  a `Response` directly. All three now apply their headers after the response
  exists, through a shared `applyResponseHeaders`, which sets a header only when
  the response does not already carry it. Precedence is unchanged: a handler's own
  value, or an inner middleware's stronger `Strict-Transport-Security`, still wins.

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

- Updated dependencies [de3298b]
- Updated dependencies [19f7119]
  - @guren/orm@2.2.1

## 2.2.0

### Minor Changes

- ee5a918: Wire i18n into the application: `createApp({ i18n })`, controller translation helpers, and Inertia `_i18n` shared props

  The i18n subsystem (I18nManager, Translator, pluralization, loaders) existed
  but had no path from an app's configuration into a request. `createApp` now
  accepts an `i18n` option:

  ```ts
  createApp({
    i18n: {
      supported: ["en", "ja"], // first entry is the default fallback
      path: "lang", // lang/<locale>/*.json via JsonLoader (default)
      // loader: new MemoryLoader(...)  // e.g. bundled messages on serverless
    },
  });
  ```

  When set, `I18nServiceProvider` builds the `i18n` container binding from the
  options, preloads every supported locale during `boot()`, and mounts
  `detectLocaleMiddleware` (query → cookie → `Accept-Language`, opt out with
  `detect: false`). Apps that register their own `I18nServiceProvider` subclass
  keep ownership of the wiring.

  Controllers gain request-locale sugar: `this.t(key, replacements?)`,
  `this.tc(key, count, replacements?)`, and `this.locale`. They use the
  request-scoped translator bound by the locale middleware when present, and
  fall back to a translator scoped to the resolved locale from the container's
  `i18n` binding (then the `setI18n()` global) — the same resolution order the
  Inertia `<html lang>` default already used.

  Inertia responses share the resolved locale and its messages as the `_i18n`
  prop (`{ locale, fallbackLocale, messages }`, active locale plus fallback
  only; disable with `share: false`), laying the groundwork for a client-side
  `useTranslation()` hook.

- 89adb3f: Typed translation keys and translation catalog checks

  `guren codegen` now emits `.guren/translations.gen.ts` for apps with a
  `lang/` directory: a `TranslationKey` union built from every
  `lang/<locale>/*.json` catalog (namespace = file name, nested keys
  flattened to dot notation), plus declaration-merging augmentations that
  register it with the server and client. `this.t()` / `this.tc()` in
  controllers and `useTranslation()` in pages then autocomplete keys and
  reject unknown ones at compile time. Apps without `lang/` (or without the
  generated file) keep plain `string` keys — the new `GurenTranslationKeys`
  registry defaults to empty. The Vite route-types plugin watches `lang/`
  and regenerates on change.

  `guren check` gains translation catalog checks, content-activated like
  `--docs`: unparseable catalog JSON (fail — the loader silently skips such
  files), keys missing from individual locales (fail — they render in the
  fallback language), and interpolation placeholders that differ between
  locales for the same key (warn). `guren check --i18n` runs them alone and
  exits non-zero on failures.

- 80ef7b1: Let the OAuth manager keep the browser binding in the session itself

  Binding a flow via `bindTo` worked but pushed four steps into every
  controller: mint a random value, store it in the session, read it back in the
  callback, forget it — guarded on the session existing, twice. Every scaffold
  and example carried the same twelve lines.

  `authorize()` and `handleCallback()` now also accept a `session`. Hand them
  `this.auth.session()` and the manager mints the per-flow binding, parks it in
  the session under `OAUTH_SESSION_BINDING_KEY`, and consumes it during callback
  verification — reading and removing it in one step, so a replayed callback
  finds nothing. A missing session (no session middleware) flows through as an
  unbound state exactly as before, warning included. The parameter is typed as
  `OAuthBindingSession` — the three session methods the manager needs — so the
  framework session satisfies it structurally and tests can pass a plain stub.

  `bindTo` remains for bindings kept elsewhere (an encrypted cookie, secure
  storage) and takes precedence when both are given. `make:auth`, the `oauth`
  blueprint, the docs, and the blog example now pass `session` instead of
  hand-rolling the plumbing.

### Patch Changes

- 80ef7b1: Carry the policy's own denial through the authorization middleware

  `authorizeMiddleware` and `authorizeResourceMiddleware` called `allows()`,
  discarded the response, and threw a generic 403 — so a policy answering with
  `denyAsNotFound()` produced a 404 through `Controller.authorize()` and a 403
  through the middleware. Both now go through the same response, keeping the
  policy's message and status; `options.message` still overrides. Multi-ability
  (`any`) checks have no single response to carry and stay generic.

  Gate and policy `before` hooks are normalized too: previously anything that was
  not a boolean was read as "keep checking", so a `Response.deny()` returned from
  `before` was dropped and a permissive ability method then allowed the action.
  Only `undefined` continues. `GateCallback`, `GateBeforeCallback`, `Policy.before`
  and `definePolicy`'s `before` accept `PolicyResult` to match.

- 80ef7b1: Make the generated private-channel check the check that actually runs

  `make:channel --private` generated a `PrivateChannel` subclass with an
  `authorize(ctx)` method, and `make:channel --presence` a `join(ctx)`. Neither
  ever ran. `BroadcastManager.authorize()` resolves a channel only through the
  callbacks registered with `channel()` / `privateChannel()` / `presenceChannel()`
  and never calls a method on a channel instance, so both were dead code — with no
  TODO or comment to say so. The presence one could not have worked in any case:
  its signature contradicted the inherited `join(member)`, which is what adds an
  already-authorized member.

  Meanwhile the `broadcasting` blueprint registered the callback that _did_ run:

  ```ts
  broadcast.privateChannel(userFeed.getBaseName(), () => true);
  ```

  Allow-all, on `users.{id}.feed`, next to a generated file that reads as though it
  authorizes. That registration also defeats the manager's own fail-closed default,
  which denies unregistered `private-`/`presence-` names.

  The generated methods now take the `ChannelAuthorizer` signature
  (`channelName, user`) so they can be registered, the presence hook is
  `authorizeJoin()` to stop colliding with `join(member)`, and a pattern carrying
  `{id}` gets an ownership check rather than a bare "is logged in". The blueprint
  registers the channel's own method.

  `BroadcastManager.authorize()` also normalizes its result. Callers read anything
  that is not `false`/`null` as authorized, so an authorizer with an
  implicit-`undefined` return path used to grant access; it now denies.

- 05f6353: Fix CSRF verification accepting a guest token on a request that carries a session

  `verifyCsrfToken` picked its validation mode from the submitted token alone: a
  token without a `sid` claim took the stateless double-submit path, which only
  compares the token against the `XSRF-TOKEN` cookie. Because that check ran even
  when the request carried a session, a guest-mode token — which anyone can mint
  by visiting the site — could authorize a state-changing request for a logged-in
  user, provided the attacker also controlled the `XSRF-TOKEN` cookie. That cookie
  carries no `Domain` restriction and no `__Host-` prefix, so any sibling
  subdomain of the same site can set it, and a same-site request still sends the
  `SameSite=Lax` session cookie. The token-minting path already enforced this rule;
  only verification was missing it.

  Verification now fixes the mode from the request — whether it carries a bindable
  session — and requires the token to be in that mode.

  Issuing had to move with it. A session created during the current request stays
  `isNew` for its whole lifetime, so the response that logs a user in was minting a
  guest token for a session that later requests authenticate with; under the new
  rule that token would be rejected on the next mutation. Three changes keep
  issuing in step:

  - `Session` gains an optional `willPersist()` reporting whether the session
    survives the response under its current id. `bindableSessionId` asks that
    instead of `!isNew`.
  - `getCsrfToken()` now tracks the session as it stands at the moment of the
    call, re-issuing when a handler changes it. Previously the first call in a
    request fixed the answer, so a handler that logged a user in and then
    rendered the token put a guest token in the response body while the cookie
    carried a session-bound one — and submitting that form was rejected.
  - Excluded paths (and the dev MCP endpoint) skip verification but no longer
    skip issuance, so an exempt endpoint that establishes a session — an OAuth
    callback — still hands back a bound token.

  `createCsrfMiddleware` settles the response cookie after the handler returns, so
  it must be mounted directly inside the session middleware. Middleware layered
  between the two that rotates or invalidates the session after its own
  `await next()` moves the id after CSRF has committed to a token. The automatic
  registration in `AuthServiceProvider` already mounts them adjacently; the
  requirement is now documented for hand-composed chains.

- 80ef7b1: Fix a policy denial being read as an approval

  `Policy` ships `deny()`, `denyWithStatus()` and `denyAsNotFound()`, which return
  an `AuthorizationResponse` object rather than `false`. `Gate.check()` returned
  the policy method's value unchanged, so every consumer truthy-tested that object
  and read the denial as an approval: `authorize()` did not throw, `allows()` and
  `Controller.can()` returned truthy, `denies()` returned `false`, `inspect()`
  reported `allowed: true`, and `authorizeMiddleware`'s `if (!authorized)` guard
  passed. A policy written as

  ```typescript
  update(user: AuthUser | null, post: Post) {
    return user?.id === post.authorId ? true : this.deny('You do not own this post.')
  }
  ```

  therefore let any user through the exact check meant to stop them. Nothing
  flagged it: the helpers are `protected`, so a policy ability method is their only
  possible call site, and `PolicyMethod` was exported but never applied to policy
  classes, so the method's return type was inferred from its body with nothing to
  check it against.

  `Gate` now normalizes every policy and gate return value through one path. An
  `AuthorizationResponse` is honoured as written, `true` allows, and anything else
  denies — unknown shapes fail closed rather than open. A new `checkResponse()`
  keeps the full response so `inspect()` reports the policy's own message, and
  `authorize()` propagates `denyWithStatus()` / `denyAsNotFound()` into the thrown
  exception's status instead of flattening every denial to 403.

  `PolicyMethod` and `definePolicy()` now accept `PolicyResult`
  (`boolean | AuthorizationResponse`), so the type matches what `Policy` has always
  offered. `PolicyResult` and the `isAuthorizationResponse()` guard are exported.

- ee5a918: Make translation interpolation literal-safe

  `Translator.applyReplacements` built its `:key`/`{key}` patterns from the
  raw replacement key and passed the value straight to `String#replace`, so a
  key containing regex metacharacters could throw or match the wrong text,
  and a value containing `$` sequences (e.g. user input with `$&`) was
  expanded instead of inserted literally. Keys are now regex-escaped and
  values replaced via a callback, keeping both fully literal.

- 80ef7b1: Key the OAuth session binding by state, not by one shared slot

  `authorize({ session })` parked its binding under a single session key and
  `handleCallback({ session })` deleted that key regardless of which state the
  callback carried. Two consequences, both measured:

  - A browser could only have one flow in flight. Open two tabs, or start over
    with a different provider, and the second `authorize()` overwrote the first's
    binding — so at least one login failed. Completing the older flow first failed
    _both_, because it consumed the newer flow's binding on its way out.
  - A callback carrying a state the browser never started still stripped the
    binding. Anyone could navigate a visitor to `/callback?code=x&state=x`
    mid-login and lock them out of the login they had actually begun.

  Bindings are now filed under the hash of the state they belong to, and a
  callback takes only its own. Concurrent flows are independent, and a forged
  callback finds nothing to remove. The list is capped at five pending flows per
  browser and prunes expired entries as it goes.

  `OAUTH_SESSION_BINDING_KEY` and `OAuthBindingSession` are also exported from
  `@guren/server` and `@guren/core`, which the previous change documented as
  public API but left reachable only through the deep module path.

- 80ef7b1: Let OAuth `state` be bound to the browser that started the flow

  `createOAuthState` stored `{ provider, redirectTo, expiresAt }` and
  `verifyOAuthState` checked only that the provider matched. Nothing tied the
  state to a browser, and the manager is a process-wide singleton, so a state
  minted for one browser was consumable by any other. `state` was unguessable and
  single-use, but _transferable_ — which is the one property it exists to prevent
  (RFC 6749 §10.12).

  That is login CSRF. An attacker requests `/auth/github` on the target app and
  captures the `state` from the redirect, separately authorizes the app against
  their own provider account and captures the `code` without letting their browser
  reach the callback, then induces a visitor into a top-level navigation to
  `/auth/github/callback?code=…&state=…`. The state verifies, the code exchanges
  for the attacker's profile, and the visitor's session is logged into the
  attacker's account. The visitor keeps using the app believing it is theirs, so
  whatever they write next — posts, uploads, a connected payment method — lands in
  an account the attacker can read. It could not be fixed from application code:
  `handleCallback()` verified state internally and accepted no session-bound value.

  `authorize()` now takes `bindTo` and `handleCallback()` takes it back. Only a
  hash of the value reaches the state store, and comparison is timing-safe. Pass a
  value only that browser can present — a session id, or a random value stored in
  the session, which also makes a logged-out visitor's session persist across the
  round trip.

  A state created without a binding still verifies, so apps written against the
  earlier API keep working; `authorize()` warns once per process when called
  without `bindTo`, and those apps stay exposed until they adopt it. `make:auth`,
  the `oauth` blueprint, the docs, and the blog example all pass it now.

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

- 80ef7b1: Stop binding the managed Vite dev server to every interface

  `Application.listen()` starts a Vite dev server on every non-production boot,
  and both the launcher and `gurenVitePlugin` replaced Vite's localhost-only
  default with `host: true`. Vite serves any file under its root — transformed
  source for `.ts`/`.tsx`, raw bytes for everything else — with no
  authentication, no origin check and no loopback gate. Anyone on the same
  network could read a developer's application source, and the scaffold's default
  `DATABASE_URL=./data/guren.db` puts the SQLite database inside that root and
  outside Vite's `server.fs.deny`, so `GET http://<dev-machine>:5173/data/guren.db`
  returned the users table — password hashes included — to any LAN peer.

  The framework already treats LAN reachability as in scope: `/_guren/mcp` and
  `/_guren/docs` are gated on a loopback socket peer precisely because templates
  bind `0.0.0.0`. The dev server it starts itself had no equivalent gate.

  `host` is now left unset, so Vite's own default applies and the project's
  `vite.config.ts` decides. Exposing the dev server on the network is an explicit
  opt-in — `--host`, `server.host` in `vite.config.ts`, or
  `app.listen({ vite: { host: true } })`.

  `preview.host` is unchanged: `vite preview` serves only `build.outDir`, never
  the project root, so it carries none of this.

  `resolveViteDevServerConfig()` is exported for callers that need the inline
  config the managed dev server would start with.

- Updated dependencies [80ef7b1]
- Updated dependencies [80ef7b1]
- Updated dependencies [80ef7b1]
  - @guren/orm@2.2.0

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
