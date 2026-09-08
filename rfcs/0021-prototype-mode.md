# RFC: Prototype Mode

**Author:** 7nohe
**Date:** 2026-09-08
**Status:** Accepted (2026-09-08 — the standard two-week discussion window
was shortened by the deciding maintainer for this solo-driven change, after
one external design review. The three must-decide open questions were
settled as proposed: generated shell with a `resources/js/prototype/index.html`
override; server-side prototype routes refused in production without
`GUREN_PROTOTYPE_ROUTES=1`; persona switching deferred to a follow-up)

## Problem

Requirements work has changed shape. Instead of exchanging specification
documents, a team generates a clickable prototype with an AI agent, hosts it
statically, lets the customer walk through it, and refines the specification
against what the customer actually clicked. Guren has nothing to offer that
phase. A scaffolded Guren app needs a Bun process, a database and a session
store before it renders its first page, so the prototype is built somewhere
else (v0, Lovable, a bare Vite SPA) and rewritten once the specification
settles. Every page, prop shape and route decided in the prototype is decided
again in the rewrite, and the two drift while the backend is being built.

The goal is that **the prototype is the app's frontend**: the page components,
their `Props`, and the route names written while prototyping are the ones the
production app ships, unchanged. Three moments have to work:

1. **Before any backend exists.** `bunx create-guren-app --prototype` then
   `bun run build:prototype` produces a directory a static host serves. No
   Bun server, no database, no environment variables.
2. **While the backend is being built.** A route whose controller is not
   written yet still renders in the prototype, and a route whose controller *is*
   written keeps rendering from its fixture when the app is built for the
   prototype. The customer-facing prototype stays green throughout.
3. **After the backend exists.** The fixture module is optional. An app that
   removes it, and the two lines that wire it in, is an ordinary Guren app.

What exists today (verified at `d024c279`, and `@inertiajs/core` 3.6.1 from
the npm tarball plus an installed 3.7.0):

- `startInertiaClient()` (`packages/inertia-client/src/app.tsx:20`) accepts an
  explicit initial `page`, falling back to `window.__INERTIA_PAGE__`. It does
  not yet expose Inertia's `http` option.
- Inertia core `^3.6.1`, the floor `@guren/inertia-client` declares, exposes
  the HTTP layer as a public interface: `HttpClient { request(config):
  Promise<HttpResponse> }` (`types/types.d.ts:30`), accepted as
  `createInertiaApp({ http })` (`:446`) and forwarded by `@inertiajs/react` to
  core's `http.setClient()`. axios is an optional peer; the default is
  `XhrHttpClient`. **The contract is narrower than "return a page object":**
  `HttpResponse.data` is a `string` that Inertia `JSON.parse`s, response
  headers are looked up by lower-case name, the built-in client runs the
  public `http.onRequest` / `onResponse` / `onError` handlers around every
  request and honours `config.signal`, and the `Page` type carries far more
  than `component`/`props`/`url` (§2 lists what matters).
- Codegen already emits what a client-side resolver needs:
  `.guren/routes.gen.ts` exports `routeManifest` (name → `{ method, path }`)
  and the `RouteParams<Name>` type derived from each path literal;
  `.guren/pages.gen.ts` exports `pages` contracts whose `PageProps<>` carry
  the `Props` interface extracted from each page component (a page whose
  `Props` the extractor cannot read gets an open contract, so the typing
  guarantees below are exactly as strong as the extraction).
- `Router` accepts an inline function handler beside `[Controller, 'action']`
  (`packages/server/src/mvc/Router.ts:42`). Controller detection is
  `Array.isArray` (`:1566`); a function handler registered with contract
  options is wrapped by `createContractHandler()` inside `register()`
  (`:740`), and `.name()` mutates the stored route *after* registration
  (`:1075`). `mount()` (`:664`) iterates the finished registry, name included.
- `Controller.inertia()` (`packages/server/src/mvc/Controller.ts:241`) merges
  `resolveSharedInertiaProps()` under the page props; `InertiaEngine.inertia()`
  alone does not. `ValidationException` is rendered by
  `InertiaServiceProvider` as a redirect back with the errors flashed into the
  session; 404s are `HttpException.notFound()`.
- The Guren Vite plugin (`packages/server/src/vite/plugin.ts`) receives
  `env` in `config()`, sets the client build's input to `resources/js/app.tsx`,
  derives `base` from `outDir`, and emits into `public/assets`. The default
  template sets `publicDir: false` in `vite.config.ts`. There is no HTML entry;
  the server renders the document (`InertiaEngine.renderDocument`).
- `make:feature` writes the validator, a `Resource` typed off the model's
  record type, the controller and the pages; it never edits the routes file,
  it prints the registrations to add (`make-feature.ts:155`). The generated
  pages import `<Entity>ResourceData` from the Resource.
- `hono/router/trie-router` is an exported, dependency-free subpath, so the
  browser can run the same matcher the server routes with.

## Proposed Solution

One fixture module, `resources/js/prototype/index.ts`, answers Inertia visits
by route name. It runs in two places with one contract:

- **In the browser**, as Inertia's `HttpClient`, when the app is built with
  `--mode prototype`. No server is involved; the output is static.
- **On the server**, behind a `prototype` route handler, for routes whose
  controller does not exist yet, in development only (§4).

The page components, `Props` types, route names and paths are declared once
and shared by both. The only thing that differs between prototype and
production is which code fills the props: the fixture or the controller.

### 1. The fixture module

```ts
// resources/js/prototype/index.ts
import { apiRoutes, definePrototype, page } from '@guren/inertia-client/prototype'
import type { ApiRoutes } from '@/.guren/api-client.gen'
import { pages } from '@/.guren/pages.gen'
import { routeManifest } from '@/.guren/routes.gen'
import type { InertiaSharedProps } from '@guren/core'

export default definePrototype({
  manifest: routeManifest,
  api: apiRoutes<ApiRoutes>(),

  shared: {
    auth: { user: { id: 1, name: 'Demo User', email: 'demo@example.com' } },
  } satisfies InertiaSharedProps,

  state: () => ({
    posts: [
      { id: 1, title: 'First post', body: '…', published: true },
      { id: 2, title: 'Draft', body: '…', published: false },
    ],
  }),

  routes: {
    'posts.index': ({ state }) =>
      page(pages.posts.Index, { posts: state.posts }),

    'posts.show': ({ state, params, notFound }) => {
      const post = state.posts.find((p) => p.id === Number(params.id))
      return post ? page(pages.posts.Show, { post }) : notFound()
    },

    'posts.store': ({ state, body, errors, redirect }) => {
      if (!body.title) return errors({ title: 'Title is required.' })
      const post = { id: state.posts.length + 1, ...body, published: false }
      state.posts.push(post)
      return redirect('posts.show', { id: post.id })
    },
  },
})
```

~~`definePrototype<typeof routeManifest, ApiRoutes, InertiaSharedProps>({ shared, state, routes })`~~
**Amended in implementation (Part 1):** the manifest is passed as a *value*
(`manifest: routeManifest`) so the client can match URLs with it at runtime,
and every generic is inferred from the object: `TManifest` from `manifest`,
`TState` from `state()`, `TShared` from `shared`, `TApi` from the phantom
`api: apiRoutes<ApiRoutes>()`. Explicit generics would have switched
inference off for `state`, which is the one that must be inferred.
`redirect`, `errors`, `notFound`, `location` and `flash` come from the handler
context, where `redirect` is typed against the manifest's route names and
params; the standalone exports remain for code outside a handler. A fifth
result, `location(url)`, answers an external redirect (the 409 row below).

Typing, all derived from the generated artifacts and the `Props` interfaces:

- Keys of `routes` are `keyof typeof routeManifest`; an unknown name is a
  type error.
- `params` is `RouteParams<Name>` from `routes.gen.ts` (`/posts/:id` →
  `{ id: string }`).
- `body` is `RouteBody<ApiRoutes, Name>` when the route declares a `body`
  schema; `unknown` otherwise. The fixture receives the **raw** body, not the
  schema's parsed output, in both runtimes (§4), so a schema transform is
  never applied on one side only. A fixture that wants coercion calls the
  schema itself.
- `page(contract, props)` requires `props` to satisfy `PageProps<typeof
  contract>`. **This is the binding that makes the fixture and the controller
  agree**: both call a page contract, and both are checked against the same
  extracted `Props`. A field added to a page's `Props` fails the fixture and
  the controller in the same `tsc` run.
- `shared` is typed by the third generic, which the app passes as its own
  `InertiaSharedProps` merge from `@guren/core`. A type-only import erases,
  so `@guren/inertia-client/prototype` itself depends on nothing from the
  server package.
- `redirect(name, params)` takes a route name, so a renamed route fails here
  too.

Handler results are a small tagged union. The server consumes it
structurally, the way `ExceptionHandler` duck-types `statusCode`, so the
server package never imports the client package:

```ts
type PrototypeResult =
  | { kind: 'page'; component: string; props: Record<string, unknown> }
  | { kind: 'redirect'; to: string; params?: Record<string, string | number> }
  | { kind: 'location'; url: string }
  | { kind: 'errors'; errors: Record<string, string>; bag?: string }
  | { kind: 'not-found' }
```

**State.** `state()` is a factory. In the browser the object is persisted in
`sessionStorage` under a versioned envelope (`{ v: 1, state }`; `persist:
'session' | 'local' | false`, default `'session'`). A tab opened from the
prototype may inherit its opener's session storage, so the guarantee is
"survives a reload", not "a new tab starts clean". `File`/`Blob` values are
kept in memory for the tab's lifetime and dropped from the persisted copy;
storage errors (quota, private mode) fall back to memory. Every route accepts
`?prototype.reset=1`, which discards the stored state and reloads the URL
without the flag, and the module exports `resetPrototypeState()`; a demo that
cannot be reset deterministically is not usable in a customer walkthrough.

**Bodies.** `FormData` bodies become a plain object; a repeated key becomes an
array, so `tags[]`-style forms and multi-file inputs survive. JSON bodies pass
through.

### 2. In the browser: `PrototypeHttpClient`

`@guren/inertia-client/prototype` is a new subpath export with no server
dependencies. It provides:

```ts
export function createPrototypeHttpClient(
  prototype: PrototypeDefinition,
  manifest: RouteManifestLike,
  options?: { base?: string },
): HttpClient

export function resolveInitialPage(
  prototype: PrototypeDefinition,
  manifest: RouteManifestLike,
  location: { pathname: string; search: string },
  options?: { base?: string },
): Page
```

**Matching.** The client builds a `TrieRouter` from `hono/router/trie-router`
over `routeManifest` at startup and matches `config.method` + path against it.
The server routes with Hono, so every path syntax the server accepts
(`:name`, `:name{regex}`, optional `:name?`, `*`) matches identically, and
the `:name*` trap `route-path-check` already reports stays a server-side
concern. `hono` becomes a peer dependency of `@guren/inertia-client` (every
Guren app has it through `@guren/core`). Rules the matcher adds on top:

- the configured `base` is stripped before matching and re-applied to every
  URL the client emits (`page.url`, redirects);
- path segments are percent-decoded before they reach `params`; the query
  string is parsed with `URLSearchParams`, repeated keys become arrays;
- two named routes with the same method and path is a `guren check` error
  (§5), not a runtime tiebreak;
- a URL that matches no named route, or an unnamed route, is a 404 (below).

**Protocol.** `request(config)` reproduces what `XhrHttpClient` does around a
request, because a custom client is responsible for it (`http.ts`
documents `processRequest`/`processResponse`/`processError` "for use by
custom HttpClient implementations"): it awaits `http.processRequest(config)`,
rejects with Inertia's cancellation error when `config.signal` is aborted,
passes the synthetic response through `http.processResponse`, and routes
failures through `http.processError`. So an app's `http.onRequest` logging or
`onError` toast works in the prototype exactly as against a server.

The synthetic response always has lower-case header names and a
`JSON.stringify`ed `Page` in `data`. The page carries `version: null` (no
asset-version handshake in a static build), `url`, `flash` at the top level,
`rescuedProps: []`, and `props.errors` always present, matching the
`errors` key `InertiaServiceProvider` injects into shared props on every
server response.

| Result        | Response                                                                                         |
|---------------|--------------------------------------------------------------------------------------------------|
| `page`        | 200, `x-inertia: true`, page JSON with `props = { ...shared, ...props, errors: {} }`              |
| `redirect`    | the target GET route's fixture is run **through the same `request()` pipeline** as a synthetic GET (interceptors and cancellation included, recursion capped at 5 hops), and that page is returned with `url` = target. On the wire this is what following the 303 produces |
| `errors`      | 200, the *originating* page re-rendered (same component, same `url`) with `props.errors` set, or `props.errors[bag]` when the visit named an error bag (`X-Inertia-Error-Bag`). This is what Guren's redirect-back-with-flash yields on the wire, and `Response` dispatches it to `onError` while keeping state as for any non-GET visit |
| `not-found`   | what the server does today: `ExceptionHandler` answers an Inertia request with a 404 JSON body and **no** `x-inertia` header, which Inertia shows in its error dialog. The client returns the same shape. A `definePrototype({ notFoundPage: pages.errors.NotFound })` option renders that page as a 200 instead, for apps that want a designed 404 in the walkthrough |
| external URL  | 409 with `x-inertia-location` and **no** `x-inertia` header, the only shape `Response` treats as a location visit |
| no fixture    | never reaches the customer: `guren check --prototype` fails the build (§5). In dev the client returns the 404 page and logs the route name and fixture path |

**Partial reloads.** When the request carries `X-Inertia-Partial-Data`
(`only`), `X-Inertia-Partial-Except` or `X-Inertia-Reset`, and
`X-Inertia-Partial-Component` names the current component, the client runs the
fixture and returns only the requested props (or all but the excepted),
because `Response.mergeProps()` overlays *every* returned prop on the current
page. A component mismatch returns the full page, as a server would.

**Feature policy for Part 1.** Supported: `preserveState` /
`preserveScroll` (handled by Inertia after a valid page), prefetch and
`cacheFor` (fixture GET handlers must be side-effect free; `guren check`
cannot verify this, the guide says it), error bags, top-level `flash`
(`flash()` helper on the handler context), `router.reload()`. Unsupported and
documented: deferred props, `mergeProps` / `prependProps` / `deepMergeProps`,
`encryptHistory`, `once` props, `scrollProps`, asset-version mismatch. A
fixture cannot express them, and Guren's own server engine emits none of
them today (`InertiaPagePayload`, `InertiaEngine.ts:31`).

**Navigation that bypasses Inertia.** A plain `<a href>`, a native form
submit, `window.location` and a direct `fetch()` never reach the
`HttpClient`. On a static host they hit the SPA fallback (a full reload that
re-resolves the initial page, losing `persist: false` state) or a 404. The
guide names this; `guren check` cannot see it.

`startInertiaClient()` gains one option:

```ts
startInertiaClient({
  pages,
  pageManifest,
  prototype: import.meta.env.GUREN_PROTOTYPE ? () => import('./prototype') : undefined,
})
```

When `prototype` is present the client loads the module, computes the initial
page from `location` with `resolveInitialPage()`, and passes `{ page, http }`
to `createInertiaApp`. When absent, nothing changes.

`import.meta.env.GUREN_PROTOTYPE` is defined as the literal `true` in
prototype mode and the literal `false` in every other mode (never absent),
with an ambient declaration shipped by `@guren/core/vite`, so the branch is
statically dead in production and the dynamic import is never a build
dependency there. Part 1 carries a test that builds the blog in production
mode and asserts no chunk contains the fixture's seed strings.

### 3. The Vite side: `--mode prototype`

No new CLI build command. The Guren Vite plugin reads `env.mode` in
`config()` (it already receives `env`) and takes a dedicated branch **before**
the ordinary client defaults, so nothing in `ensureBuild` reaches its
`outDir`/`base`/`publicDir` logic in this mode:

- `define['import.meta.env.GUREN_PROTOTYPE'] = 'true'`;
- `build.outDir = 'dist/prototype'`, `build.emptyOutDir = true`;
- `base = options.prototype?.base ?? '/'`. A GitHub project page or a preview
  deployment under a subpath sets `guren({ prototype: { base: '/repo/' } })`
  and the same value reaches `createPrototypeHttpClient` through the define
  `import.meta.env.GUREN_PROTOTYPE_BASE`, so asset URLs, `page.url` and
  route matching agree. A user-set `base` wins over the option;
- `publicDir = 'public'` and `build.copyPublicDir = true`, both set
  explicitly because the default template disables `publicDir` (the ordinary
  build leaves `public/` to the server);
- `build.manifest = false`, `build.ssrManifest = false`: there is no server to
  read them;
- the rollup input is the generated shell `.guren/prototype/index.html`
  (`<!doctype html>`, `<html lang>`, `<meta name="robots" content="noindex">`,
  `<div id="app">`, a module script for `resources/js/app.tsx`). Vite keeps
  an input's path relative to the project root, so a `generateBundle` hook
  moves the emitted file to `dist/prototype/index.html`. An app that ships
  `resources/js/prototype/index.html` gets that file as the shell instead of
  the generated one; that is how favicons, a theme prepaint script, or a
  Google Fonts link reach the prototype, since `setInertiaDocument()` is
  server-side and the static build cannot read it;
- after the build, `index.html` is copied to `404.html` and a `_redirects`
  file (`/* /index.html 200`) is written. GitHub Pages ignores `_redirects`
  but serves `404.html` for unknown paths; Netlify and Cloudflare Pages read
  `_redirects`; Workers Static Assets needs `not_found_handling:
  "single-page-application"` and Vercel a rewrite. The guide carries that
  matrix, and "any static host" in this RFC means those five, tested;
- in `vite --mode prototype` (dev), a `configureServer` middleware answers
  every `text/html` request with the shell run through `transformIndexHtml`.
  Vite's `appType: 'spa'` alone serves only the root `index.html`, which
  this app does not have. This is the prototype dev loop: Vite alone, no Bun
  server.

The scaffolded `package.json` gets two scripts:

```json
"dev:prototype": "vite --mode prototype",
"build:prototype": "guren codegen && guren check --prototype --ci && vite build --mode prototype"
```

**Amended in implementation (Part 1):** `check --prototype` is Part 2, so the
Part 1 script is `guren codegen && vite build --mode prototype`; Part 2 inserts
the gate. `startInertiaClient` takes `prototype: { load, base }`, with `base`
read from Vite's own `import.meta.env.BASE_URL` rather than a second define.

Ordering: codegen loads `routes/web.ts` through `load-routes.ts`, which
imports the file, runs the registrar and reads `definitions()`. A routes file
that imports `prototype` from `@guren/core` and no controller loads fine, and
no generator imports the fixture module: `routes.gen.ts` and `pages.gen.ts`
are what the fixture is typed *against*, so they must exist first, which is
why codegen runs first even on a fresh scaffold. The fixture is then
typechecked by `tsc` like any app file, and `guren check --prototype` (§5)
reads it for the wiring rules before Vite runs.

### 4. On the server: the `prototype` route handler

```ts
import { Router, prototype } from '@guren/core'
import PostController from '../app/Http/Controllers/PostController.js'

export function registerWebRoutes(router: Router): void {
  router.get('/posts', [PostController, 'index']).name('posts.index')   // implemented
  router.get('/posts/:id', prototype).name('posts.show')                 // still on its fixture
  router.post('/posts', { name: 'posts.store', body: PostPayloadSchema }, prototype)
}
```

`prototype` is a branded object exported by `@guren/server`, not a function.
`register()` recognises it in **both** branches (with and without contract
options), before any handler wrapping, and stores `prototype: true` on the
`RegisteredRoute` with the contract schemas kept as for a controller route.
A function sentinel would lose its identity inside `createContractHandler()`,
and nothing in `register()` knows the final name, since `.name()` runs on the
returned builder afterwards. The resolution therefore happens in `mount()`,
which has the finished route: it wraps a handler that reads `route.name`,
resolves the fixture through the container, builds the same handler context
the browser builds (`params` from `c.req.param()`, `query`, the **raw**
body from `c.req.json()` / `parseBody()`, `shared` from
`resolveSharedInertiaProps()`), runs it, and maps the result:

| Result      | Server behaviour                                                              |
|-------------|-------------------------------------------------------------------------------|
| `page`      | the same path as `Controller.inertia()`: shared props resolved and merged under the page props, then `inertia(component, props)`. A fixture's `shared` is applied **under** the real resolvers, so a real `auth.user` from a session wins over the fixture's demo user |
| `redirect`  | `303` to `router.route(to, params)`                                           |
| `errors`    | throws `ValidationException(errors)`, so the flash-and-redirect-back path is the production one |
| `not-found` | throws `HttpException.notFound()`                                             |

Before mounting, the router validates every `prototype` route: unnamed is a
boot error naming the path; named but absent from the fixture is a boot error
naming the route. Route middleware runs unchanged, so an `auth`-guarded
prototype route is guarded by the real session middleware, and a fixture's
`shared.auth` does **not** log anyone in.

The fixture module reaches the server through `createApp()`:

```ts
const app = createApp({
  routes,
  providers,
  prototype: () => import('../resources/js/prototype/index.js'),
})
```

The import is lazy, resolved on the first `prototype` route hit. An app whose
routes are all promoted pays nothing; an app with `prototype` routes and no
`prototype` option fails at boot naming the first such route.

**Server state is per process and shared by every request.** The `state()`
object lives in the module instance the server imported; two users of the
same dev server see each other's edits. That is acceptable for a developer's
own `bun run dev` and for nothing else, so the boot **refuses** `prototype`
routes when `NODE_ENV === 'production'` unless `GUREN_PROTOTYPE_ROUTES=1` is
set (same `GUREN_*` / `=== '1'` shape as `GUREN_MCP`), and `guren doctor`
reports the routes still on their fixture as a deploy blocker. The
customer-facing artefact is the static build; the server handler exists so
that `bun run dev` keeps rendering half-implemented apps.

`RouteDefinition` gains `prototype?: true`. That one field is how the rest of
the CLI sees the state of the migration:

- `guren context` lists routes still on their fixture as the **prototype
  backlog**, so an agent asked to "implement the next screen" reads the list
  instead of diffing controllers against routes;
- `guren audit` treats a `prototype` route like an inline handler: a mutating
  one with no body schema warns as today;
- agent codegen (`agents-types.ts`) reads definitions, so a `prototype` route
  declaring `.agent()` would be advertised as a tool with no implementation
  behind it. That is a `guren check` error (§5), and `deriveAgentTools()`
  skips such routes with a warning.

### 5. `guren check --prototype`

Content-activated: an app with no `resources/js/prototype/index.ts` and no
`prototype` route contributes nothing. Like `--arch` / `--docs` / `--spec`,
the flag selects the suite and sets the exit code, which is what lets
`build:prototype` gate on it.

| Rule                                                             | Level |
|------------------------------------------------------------------|-------|
| `prototype` route without a name                                 | error |
| Named `prototype` route with no fixture entry                    | error |
| Fixture entry naming a route that does not exist                 | error (tsc catches it too; reported for `--json` consumers) |
| Two named routes sharing method and path                         | error (the client matcher cannot tell them apart) |
| `prototype` route declaring `.agent()`                           | error |
| `prototype` routes present, `createApp()` without `prototype`    | error |
| Named GET route with no fixture entry                            | warn, listed as "not reachable in the prototype" |
| Fixture wired in `app.tsx` but no `resources/js/prototype/`      | error |

The fixture is read the way `session-config.ts` reads a `SessionConfig`:
by AST, anchored on the `definePrototype(` call, collecting the string keys
of `routes`. A fixture built dynamically (spread, computed keys) is reported
as "unreadable, not checked" rather than passed. Nothing in the CLI executes
app code (the CLI never boots the app).

### 6. Scaffolding

- **`guren add prototype`** writes `resources/js/prototype/index.ts` (with a
  `shared.auth` entry when the app has auth), adds the two scripts, patches
  `startInertiaClient()` in `resources/js/app.tsx` with the `prototype`
  option and `createApp()` in `src/app.ts` with the lazy import, and writes
  the ambient `GUREN_PROTOTYPE` declaration into `resources/js/env.d.ts`.
  Idempotent, like `guren add session`. `guren add prototype --remove`
  reverses the two wiring lines and the scripts, and leaves the fixture
  directory for the author to delete: that is the "after the backend exists"
  step, and without it the lazy imports keep the module a compile-time
  dependency.
- **`create-guren-app --prototype`** runs it after scaffolding, the way the
  `worker` blueprint runs its blueprints.
- **`make:feature Post --fields … --prototype`** writes the validator (the
  future controller needs it, and `RouteBody` typing needs it now), the page
  components, a fixture block appended to `resources/js/prototype/index.ts`
  (index/show/create/edit/store/update/destroy built from `--fields`), and a
  data type `resources/js/types/Post.ts` exporting `PostData`, which the
  pages import instead of `PostResourceData`. No model, migration, Resource
  or controller is written. Like today's `make:feature`, it prints the route
  registrations to add, with `prototype` in place of the controller.
- **Promotion.** `make:feature Post --fields …` without `--prototype`, in an
  app whose `posts.*` routes are `prototype`, writes the model stub, the
  migration, the Resource and the controller as today, with one difference:
  the Resource's `toArray()` is typed against the existing `PostData`, so the
  shape the pages were built on is now the contract the serializer must
  satisfy. It prints the exact `prototype` → `[PostController, 'action']`
  replacements for the routes file. Rewriting the routes file in place is
  deliberately **not** in this RFC: `make:feature` has never edited it, and an
  idempotent AST rewrite with conflict handling is its own proposal (Open
  Question 4).

### 7. Packages and versioning

| Package                  | Change                                                             | Bump  |
|--------------------------|--------------------------------------------------------------------|-------|
| `@guren/inertia-client`  | `prototype` subpath: `definePrototype`, `page`, `redirect`, `errors`, `notFound`, `resetPrototypeState`, `createPrototypeHttpClient`, `resolveInitialPage`; `startInertiaClient({ prototype })`; `hono` peer | minor |
| `@guren/server`          | `prototype` sentinel, `ApplicationOptions.prototype`, `RouteDefinition.prototype`, the boot validation and production refusal, Vite plugin `--mode prototype` + `prototype.base` option, `deriveAgentTools()` skip | minor |
| `@guren/core`            | re-exports (`export *`); `@guren/core/vite` ships the ambient env declaration | minor |
| `@guren/cli`             | `guren add prototype` (+ `--remove`), `make:feature --prototype` and promotion typing, `check --prototype`, `context` backlog, `doctor` deploy blocker | minor |
| `create-guren-app`       | `--prototype` flag, scripts and `env.d.ts` in the default template | minor |

All additive. The `@inertiajs/core` floor stays `^3.6.1`, which has
`HttpClient`. `@guren/server` gains no dependency on `@guren/inertia-client`.
Templates that adopt these APIs are red on `smoke:starter:npm` until the
release that ships them, as `common-pitfalls.md` describes.

### 8. Delivery

- **Part 1 — static prototype** (shipped as `feat/rfc0021-part1`). `@guren/inertia-client/prototype` with the
  protocol conformance tests run against Inertia's real `Response` class (page,
  redirect, errors with and without a bag, not-found, external location,
  partial reload, cancellation, interceptors), `startInertiaClient({
  prototype })`, the Vite mode with build assertions on the exact root files
  and a dev-server test on a nested route, the production-bundle test.
  Proven end to end by building `examples/blog` with `--mode prototype`,
  serving `dist/prototype` from a plain static file server under `/` and under
  `/blog/`, and driving the posts CRUD in Playwright with the Bun server
  stopped.
- **Part 2 — server side and check.** The sentinel, `createApp({ prototype })`,
  `RouteDefinition.prototype`, the boot validation and production refusal,
  `check --prototype`, `context` backlog, `doctor`. Proven by a TestApp test
  where a `prototype` route renders its fixture under the real shared-props
  pipeline, redirects, and surfaces validation errors through
  `ValidationException`, plus a test that a production boot refuses.
- **Part 3 — scaffolding.** `guren add prototype`, `create-guren-app
  --prototype`, `make:feature --prototype` and promotion typing. Proven by a
  smoke that scaffolds with `--prototype`, runs `build:prototype` with no
  database configured, then promotes `Post` and runs the ordinary starter
  smoke.
- **Part 4 — docs and dogfood.** A "Prototype first" guide (host matrix, the
  reset flow, the navigation limitations, the noindex default and the
  access-control warning), a tutorial chapter that starts from the prototype,
  and the blog example carrying a fixture.

## Alternatives Considered

**Mock Service Worker (MSW).** The industry default for browser-side API
mocking, and it would work: it intercepts XHR too. Rejected because static
hosts make Service Worker registration the fragile part (the first load races
the worker taking control, scope rules, HTTPS-only), it adds a dependency to
every prototype, and it is strictly more machinery than Inertia's own
`HttpClient` interface, which is one method and needs no registration step.

**Swapping the axios adapter.** Inertia 2.x used axios, so an adapter swap was
the natural hook. Inertia 3 made axios an optional peer and defaults to its own
`XhrHttpClient`, so an adapter swap would first have to force axios back in,
then reach into it. The public `HttpClient` interface is the supported
replacement for exactly this.

**A mock server instead of a static build** (`guren dev --mock`, controllers
replaced by fixture responders). This is what §4 provides, and it is useful
during development. It fails the first requirement on its own: a
customer-facing prototype must not need a running Bun process. The static
client is the product; the server handler is what keeps `bun run dev` working
on a half-implemented app.

**JSON files per route** (`prototype/posts.index.json`). No logic means no
`POST`, no state, no redirect, no validation errors, and no typing against
`Props`. A prototype that cannot submit a form does not settle a
specification. Static data still belongs in the TS fixture as plain object
literals, which is what `state()` holds.

**A hand-written path matcher in the client.** Smaller than a Hono import,
and the first version of this RFC proposed it. Rejected because every gap
between it and Hono's syntax is a route that is clickable on the server and
dead in the prototype, and `route-path-check.ts` already documents how
non-obvious that syntax is. Running Hono's own router gives parity by
construction.

**Running the whole Guren app in the browser.** Hono runs in a browser, but
`@guren/server` reaches for `node:crypto`, the filesystem and the ORM, and
routing through controllers that have no backend is the thing being avoided.

**A separate `routes/prototype.ts`.** It would let the fixture declare routes
without touching `routes/web.ts`, and it would be the second route source of
truth the whole design exists to avoid. The `prototype` handler keeps the
route graph in one file and turns "which routes are still mocked" into a
field on `RouteDefinition`.

## Migration Path

Purely additive. Existing apps see no change until they run `guren add
prototype`. An app that never adopts it has no `prototype` routes, a
`GUREN_PROTOTYPE` define of `false`, and an unchanged client bundle, which
the Part 1 bundle test pins.

## Open Questions

Decided before Accepted:

1. **Shell ownership.** §3 proposes a generated shell with an optional
   `resources/js/prototype/index.html` override. The alternative is to have
   codegen serialise `setInertiaDocument()` values into the shell, which
   keeps one source of truth for favicons and prepaint scripts but couples
   the static build to a server-side call. Which?
2. **Server prototype routes in production.** §4 refuses them unless
   `GUREN_PROTOTYPE_ROUTES=1`. Is an opt-in even wanted, given the state is
   process-shared, or should the refusal be unconditional and the static
   build the only customer-facing form?
3. **Persona switching.** A walkthrough usually wants "as a guest / as an
   admin". `shared` supports one identity. A `personas` map plus a switcher
   in the shell is the obvious extension. Part 1, or a follow-up? (Leaning
   follow-up: nothing in Part 1 forecloses it.)

Follow-ups, not blocking acceptance:

4. **In-place promotion of the routes file.** An idempotent AST rewrite of
   `prototype` → `[Controller, 'action']`, with conflict handling. Worth its
   own short RFC once Part 3 has shown how often the printed replacements are
   applied by hand versus by an agent.
5. **Fixtures as test data.** Letting a controller test assert
   `assertInertia(...).toMatchFixture('posts.index')`, so the fixture becomes
   the expected value for the controller that replaced it.
6. **Client-side guards.** The browser runs no middleware; an `auth` route is
   reachable as a guest unless the fixture checks `shared.auth.user`. A
   `guards` map keyed by middleware alias would give `requireAuthenticated` a
   client counterpart. Documenting the fixture-side check is enough for now.
7. **Access control on the hosted prototype.** Out of scope for the build
   (Cloudflare Access, Vercel password protection, a basic-auth Worker), but
   the guide must say so, since a prototype with a `shared.auth` "logged-in"
   user on a public URL is easy to misread as a leak.
