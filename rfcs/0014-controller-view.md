# RFC: First-Class Content Rendering — `Controller.view()`

**Author:** 7nohe
**Date:** 2026-08-22 (revised 2026-08-25)
**Status:** Accepted (2026-08-25 — accepted by the project maintainer under
author authority; the standard two-week discussion window was waived for this
solo-maintained change, as with RFC 0012)

> Additive **minor** to `@guren/server` and `@guren/core`: a `view()` method on
> the existing `Controller`, a `viteAsset()` helper, and `./jsx-runtime` /
> `./jsx-dev-runtime` export subpaths on both packages. No breaking changes.
>
> **Pivot note (2026-08-25):** this RFC began life as a separate package,
> `@guren/plugin-content`, with an additive-plugin premise. Three review
> passes and the maintainer's decision moved it into the framework proper.
> The plugin form is preserved under Alternatives Considered; the measured
> constraints that survived the pivot are kept below, with their consequences
> rewritten for the built-in design.

## Problem

Guren ships one first-class way to render a page response: `this.inertia(page,
props)`. That is the right choice for interactive, stateful UI — but it has a
measured cost for public, read-mostly content pages (blog posts, docs,
marketing pages) that don't need client-side hydration at all.

On an initial HTML document request, `InertiaEngine` always emits
`<script>window.__INERTIA_PAGE__ = {...}</script>` in `<head>`, whether or
not SSR is enabled. (`X-Inertia` visits and JSON-preferring requests return
serialized JSON instead, and are not what this RFC is about — a content page
is reached by a fresh navigation or a crawler.) When SSR is enabled *and
succeeds*, the same content is **additionally** rendered into `<body>` as
HTML, so a large prop (an article body, most obviously) ships twice: once as
escaped JSON, once as HTML. Measured on 2026-08-22 while migrating a real
Guren app off Inertia for its public pages (a personal blog: 21 posts, Shiki
syntax highlighting):

| | largest post |
|---|---|
| `__INERTIA_PAGE__` (JSON) | 238 KB |
| full page, Inertia SSR (measured) | 443,392 bytes |
| full page, plain SSR HTML (measured) | 144,241 bytes |

The same defect exists in this repository. Measured against production
guren.dev on 2026-08-22, `/docs/guides/authentication` ships 401,989 bytes of
which 148,448 is the duplicated `__INERTIA_PAGE__` blob — and the duplicate
survives compression well enough to be **33.7% of the gzipped response**
(51,579 → 34,221 bytes with the blob removed).

**The framework has no ergonomic way to return server-rendered HTML from a
controller.** `Controller` has `this.inertia(...)` and nothing else that
produces a page. In practice this pushed the migrated app to hand-write a
`renderPage(options, body): Response` free function that string-concatenates
HTML, with a hand-rolled `escapeHtml()` the author has to remember to call at
every interpolation site — a stored-XSS bug waiting for the first forgotten
call site. Same "dogfood, then absorb" shape that produced
`@guren/plugin-markdown` (RFC 0012).

## Proposed Solution

Add `view()` to the framework's `Controller`, rendering a `hono/jsx`
component to a plain HTML `Response`:

```typescript
// In a scaffolded app — controller stays plain .ts, zero JSX syntax
import { Controller } from '@guren/core'
import { PostPage } from '../View/PostPage.js'
import { Post } from '../Models/Post.js'

export default class BlogController extends Controller {
  async show() {
    const post = await Post.findOrFail(/* ... */)
    return this.view(PostPage, { post })   // component + props, not a JSX element
  }
}
```

```tsx
// app/View/PostPage.tsx — server-only, never hydrates
/** @jsxImportSource @guren/core */
import type { FC } from '@guren/core'
import type { PostRecordData } from './types.js'
import { Layout } from './Layout.js'

export const PostPage: FC<{ post: PostRecordData }> = ({ post }) => (
  <Layout>
    <title>{post.title} | example.com</title>
    <meta name="description" content={post.description} />
    <article dangerouslySetInnerHTML={{ __html: post.contentHtml }} />
  </Layout>
)
```

`hono/jsx` is the render engine — already a dependency of `@guren/server`,
auto-escaping by default, and (verified below) hoisting `<title>`, `<meta>`,
and `<link>` into `<head>` from anywhere in the tree. No new template
language, and controllers never contain JSX.

Note the pragma and the `FC` import both point at `@guren/core`, not at
`hono` — apps do **not** add hono to their dependencies. The subpath
re-exports that make this work are part of this proposal and are what
dissolves the copy-identity problems the plugin form fought (see "Runtime
identity by construction").

### `Controller.view()`

```typescript
// packages/server/src/mvc/Controller.ts (addition)
import { createElement, type FC } from 'hono/jsx'

export interface ViewOptions {
  status?: number
  headers?: HeadersInit
  /**
   * Prepend `<!doctype html>` and require a full document (an `<html>` root).
   * Pass `false` for an intentional fragment response — no doctype, no check.
   */
  doctype?: boolean
}

protected async view<P>(component: FC<P>, props: P, options: ViewOptions = {}): Promise<Response> {
  // Build a real hono element and let hono reduce it. Invoking the component
  // directly and reducing by hand looks equivalent and is not: it skips
  // hono's escaping of raw strings inside a `Child[]`. See "Stringifying a
  // component tree" below.
  const body = String(await createElement(component as never, props as never).toString())

  if (options.doctype !== false && !/^\s*<html[\s>]/i.test(body)) {
    const name = component.displayName ?? (component as { name?: string }).name ?? 'component'
    throw new Error(
      `view(): ${name} rendered a fragment, not a document. ` +
      `Wrap the page in your Layout (an <html> root), or pass { doctype: false } ` +
      `for an intentional fragment response. Without <html>/<head>, <title> and ` +
      `<meta> tags are not hoisted and the page ships unstyled.`,
    )
  }

  const headers = new Headers(options.headers)
  if (!headers.has('content-type')) headers.set('content-type', 'text/html; charset=utf-8')
  return new Response((options.doctype === false ? '' : '<!doctype html>') + body, {
    status: options.status ?? 200,
    headers,
  })
}
```

The two `as never` casts bridge to `createElement`'s deliberately loose
internal signature (`Props = Record<string, any>`, unexported by hono); the
safety boundary is `view()`'s own generic signature, checked at the call
site. A wrong prop name at a `this.view(PostPage, …)` call is `TS2561` — no
codegen, no staleness window, unlike the Inertia page-prop story which
depends on `bunx guren codegen` having run.

### The forgotten-`<Layout>` guard

The document check above exists because forgetting the Layout **fails
softly**, and softly is worse. Measured: a component that renders content
without an `<html>` root still produces a 200 response — but hono's head
hoisting needs a `</head>` in the buffer to hoist into, so every `<title>`
and `<meta>` the page emitted **stays inline in the body**, and no stylesheet
is linked. Visually the page is unstyled (a human notices in dev); for a
crawler the SEO tags are silently in the wrong place (nobody notices until
rankings do). The error above turns that into an immediate, named failure at
first render in dev, and `{ doctype: false }` doubles as the explicit "this
is a fragment on purpose" escape hatch. Deterministic, so a page that renders
once in development can never ship the broken shape to production.

### `viteAsset()` — the framework resolves asset URLs

A content Layout needs the stylesheet URL, which is environment-dependent:
the Vite dev server serves `resources/css/app.css` directly in development,
while a production build renames it to a hashed `/assets/app-a1b2c3.css`
recorded in `public/assets/manifest.json`. Inertia pages get this resolved
automatically; content pages get a public helper doing the same:

```tsx
// app/View/Layout.tsx
/** @jsxImportSource @guren/core */
import { viteAsset, type FC, type PropsWithChildren } from '@guren/core'

export const Layout: FC<PropsWithChildren> = ({ children }) => (
  <html lang="en">
    <head>
      <meta charSet="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <link rel="stylesheet" href={viteAsset('resources/css/app.css')} />
    </head>
    <body>{children as never}</body>
  </html>
)
```

`viteAsset(entry)`:

- **dev** (`VITE_DEV_SERVER_URL` set): returns `${devServerUrl}/${entry}`.
- **production**: looks `entry` up in the Vite manifest
  (`public/assets/manifest.json`, falling back to `.vite/manifest.json`,
  cached after first read) and returns `/assets/<hashed file>`.
- **neither resolvable**: throws an error naming both branches and the paths
  it tried — never a silent empty string.

Implementation-wise this factors the manifest-location and dev-server logic
already living in `packages/server/src/http/inertia-assets.ts` into a shared
internal helper; the `GUREN_INERTIA_*` flow keeps working unchanged on top of
it. This is the one part of the proposal that reaches beyond `Controller`,
and it is why the original plugin form could not deliver it.

The reference `Layout` above also encodes the head rule the dedupe
measurements force (see below): its `<head>` carries only what pages never
restate — charset, viewport, stylesheet. Title and description belong to the
page component; hoisting places them.

### JSX runtime: `@guren/core/jsx-runtime`

App View files use `/** @jsxImportSource @guren/core */`. To make that
resolve, `@guren/server` and `@guren/core` each add two export subpaths whose
entire content is a re-export:

```typescript
// packages/server/src/jsx-runtime.ts        →  export * from 'hono/jsx/jsx-runtime'
// packages/server/src/jsx-dev-runtime.ts    →  export * from 'hono/jsx/jsx-dev-runtime'
// packages/core/src/jsx-runtime.ts          →  export * from '@guren/server/jsx-runtime'
// packages/core/src/jsx-dev-runtime.ts      →  export * from '@guren/server/jsx-dev-runtime'
```

plus the matching `exports`-map entries and tsdown entries. The server barrel
additionally re-exports `type FC` and `type PropsWithChildren` from
`hono/jsx` (flowing to core via its existing `export *`), so a View file
imports every name it needs from `@guren/core`.

Verified with a two-level fixture chain (`@fake/core` → `@fake/server` →
`hono`): `tsc` 7.0.2 accepts the pragma and resolves `JSX.IntrinsicElements`
through both hops, and Bun renders through the chain with escaping and
hoisting intact.

What this buys, in order of importance:

1. **Apps never declare `hono`.** The phantom-dependency problem measured
   below (hono unresolvable from app code under isolated linkers) is gone —
   the pragma resolves through `@guren/core`, which the app already has.
2. **Copy identity by construction.** The runtime that compiles the app's JSX
   and the `createElement` inside `view()` resolve through the same chain to
   the same hono installation. The two-copies question cannot arise.
3. **Core-first stays intact.** User-facing code references `@guren/core`
   only, per the repo's own rule.

### Runtime identity by construction

The plugin form of this RFC spent two revisions on hono dependency shape
(type-only peer, then runtime peer, floor negotiations) because the rendering
code lived *outside* the package that owns hono. Built in, the question
dissolves: `@guren/server` already depends on hono and `view()` uses that
copy; the app-side pragma resolves to the very same copy through the subpath
chain.

One residual case was measured rather than assumed: an app that
independently installs hono and writes `/** @jsxImportSource hono/jsx */`
puts a **second** hono copy in the tree the server-copy `createElement` then
renders. Forced in a fixture (two full hono installations, pragma on copy A,
`createElement` from copy B): rendering is **correct** — escaping, hoisting,
and nested components all behave, because hono's render path is structural
rather than `instanceof`-gated (verified on 4.13.x). So the direct pragma is
*unnecessary*, not broken; the docs say "use `@guren/core`" and need no
warning machinery. (Cross-copy `createContext` would not survive — module
scope — but context across that boundary has no supported use here.)

`@guren/server` bumps its own hono dependency floor to `^4.13.0`:
`FunctionComponentResult` — the component contract `view()` renders — was
introduced in hono 4.13.0 (verified by unpacking 4.12.29 and 4.13.0 from the
registry; 4.12.29's `FC` returns a narrower union). The full fixture matrix
passes against an installed `hono@4.13.0` exactly.

## Verified constraints (2026-08-22 → 2026-08-25)

Every claim here was read out of this repository's sources or measured with a
fixture. Findings that reshaped the proposal along the way are kept — three
independent review passes (two Copilot models, one Codex) each overturned
something, and the reasoning that produced the mistakes is easy to repeat.

### `ViewEngine` cannot carry this feature

`packages/server/src/mvc/ViewEngine.ts` in full is a `Map<string,
ViewRenderer>` where `ViewRenderer = (template: string, props) => Response |
Promise<Response>`. The template is a **string**; an `FC` is a function.
`ViewEngine` has exactly one registration in the repository
(`InertiaServiceProvider`) and no `Controller` method reads from it. The
first draft proposed routing `view()` through it; that was wrong, and the
motivating app's hand-written bypass was forced, not lazy. **This RFC does
not touch `ViewEngine`.**

### `hono/jsx`'s real surface

- `FC<P>` returns `FunctionComponentResult = HtmlEscapedString | Child[] |
  Promise<HtmlEscapedString | Child[]> | null` (since 4.13.0). **A component
  does not return a string** — four shapes, and `view()` must be correct for
  all of them.
- `hono/jsx` does **not** export `Props` (`TS2614` if you try); it lives in
  `hono/jsx/base`, which hono's `exports` map does not publish at all.
- `renderToReadableStream` lives at `hono/jsx/streaming`.

### Stringifying a component tree — where the XSS lived

- `String(node)` **throws** `TypeError: No default value` when the tree
  contains a nested async component.
- `await createElement(C, p).toString()` on an async root returns a **boxed
  `String` object**, not a primitive — hence the `String(...)` wrapper in
  `view()`.
- Two revisions reduced the result **by hand** so the rendering code could
  avoid importing hono at runtime. That reduction had a stored-XSS hole,
  found by the Codex review pass: `Child` legally includes `string` and
  `Promise<string>`, hono escapes those when it walks children itself, and
  the hand reducer called `String()` on them instead:

  | component returns | hand-reduced | `createElement(...).toString()` |
  |---|---|---|
  | `['<script>alert(1)</script>', <p>ok</p>]` | `<script>…` **verbatim** | `&lt;script&gt;…` escaped |
  | `[Promise.resolve('<b>raw</b>'), <p>ok</p>]` | `<b>raw</b>` **verbatim** | escaped |

  Three revisions missed it because every fixture put only `JSXNode`s in the
  array. **The rule that survives: let hono own the reduction.** The
  regression suite must include a raw string and a `Promise<string>` inside a
  `Child[]`, asserted escaped.
- What auto-escaping covers, exactly: tag/attribute breakout is prevented
  (`<script>` as text child, `" onmouseover="` in an attribute); URL
  *schemes* are **not** sanitized — `href={'javascript:alert(1)'}` passes
  through verbatim. Scheme validation is the caller's job
  (`@guren/plugin-markdown`'s sanitizer allowlists `http`/`https`/`mailto`);
  the test suite pins this boundary in both directions.
- hono/jsx emits **no doctype**; `view()` prepends it.

### hono is not resolvable from app code — why the pragma goes through core

Measured: `import.meta.resolve('hono/jsx')` fails from `packages/core`,
`packages/cli`, `packages/plugin-markdown`, and `examples/blog` under bun's
isolated linker; it succeeds from app code only under npm's hoisting, as a
phantom dependency. The original plugin design answered this with a peer
dependency on the app; the built-in design answers it with the
`@guren/core/jsx-runtime` subpath, which resolves through a dependency edge
that actually exists.

### hono/jsx hoists `<title>`, `<meta>`, `<link>` into `<head>` natively

Three revisions asserted hono/jsx is a flat string buffer with no portal
primitive. It is not — it implements React-19-style metadata hoisting
(`jsx/intrinsic-element/components.js`, `insertIntoHead`), through plain
`createElement`, no middleware:

| element rendered deep inside `<body>` | lands in `<head>` |
|---|---|
| `<title>`, `<meta>`, `<link>` (incl. canonical, RSS alternate) | **yes** |
| `<script type="application/ld+json">`, `<style>` | no — stays in place |

Conditions and traps, all measured on 4.13.0 and 4.13.1:

- The output must **contain a `<head>`** — a fragment gets no hoisting.
  (This is what makes the forgotten-Layout guard necessary.)
- JSON-LD as a text child is HTML-escaped into garbage; it needs
  `dangerouslySetInnerHTML` with `<` written as `\u003c`.
- **De-duplication:** literal children of the Layout's `<head>` do not
  participate — hoisted duplicates append after them, and since browsers use
  the *first* `<title>`, a Layout that hard-codes a default title silently
  shadows every page's. Hoisted `<meta>` dedupes by `name` (first-rendered
  wins); hoisted `<title>` never dedupes. Hence the Layout head rule:
  charset, viewport, stylesheet — nothing pages restate.

### Type safety across the two JSX runtimes

An app now contains two JSX dialects: React (`resources/js/pages/`, Inertia,
hydrates) and hono via `@guren/core` (`app/View/`, server-only). Verified
against `tsc` 7.0.2 with an app-shaped fixture: the compiler already rejects
a missing pragma on an `FC`-annotated component (`TS2322`), a React component
passed to `view()` (`TS2345`), a wrong prop name at the call site (`TS2561`),
and an `FC`-annotated View component imported into a React page (`TS2786`).

Two shapes compile silently: a pragma'd component with **no `FC` annotation**
imported into a React page (hono's `JSX.Element` is a `String` subtype, which
React accepts as `ReactNode`), and a React element placed as an **expression
child** of a hono element, which renders as empty output. The first is closed
by a documented `guren.arch.ts` rule —

```typescript
{ from: 'resources/js/pages/**', disallow: 'app/View/**', includeTypeImports: true }
```

— the second is within-file and no boundary rule can see it; the scaffold
emitting explicit `: FC<Props>` annotations is the practical mitigation. The
directory split (`app/View/`, outside `resources/js/pages/`) is required
independently: `packages/cli/src/pages-types.ts` claims everything under the
default `pagesDir` as Inertia pages for codegen and the Vite watcher.

### Inertia payload framing, stated precisely

"Always emits `__INERTIA_PAGE__`" holds for initial HTML document requests;
`X-Inertia` visits and JSON-preferring requests receive JSON, and failed SSR
falls back to the empty CSR shell (single copy) rather than doubling. The
content-page case — fresh navigation, crawler — is exactly the always case.

## Implementation Plan

All inside the existing packages; no new package, no new build wiring.

**`packages/server`:**

- `mvc/Controller.ts`: add `view()` + `ViewOptions` (names verified unused).
- `src/jsx-runtime.ts`, `src/jsx-dev-runtime.ts`: re-exports; `exports`-map
  and tsdown entries to match.
- Barrel: `export { viteAsset }`, `export type { FC, PropsWithChildren }
  from 'hono/jsx'`, `export type { ViewOptions }`.
- `http/`: factor the manifest/dev-server resolution out of
  `inertia-assets.ts` into a shared internal helper; implement `viteAsset()`
  on top; `GUREN_INERTIA_*` behavior unchanged.
- `package.json`: hono `^4.12.29` → `^4.13.0`.

**`packages/core`:**

- `src/jsx-runtime.ts`, `src/jsx-dev-runtime.ts` re-exporting the server's;
  `exports`-map entries. (`view()`, `viteAsset`, and the types flow through
  the existing `export * from '@guren/server'` — but the subpaths are real
  file additions, so core ships a release of its own.)

**Changesets:** minor for `@guren/server`, minor for `@guren/core` — the
core release is mandatory, not optional: without it the new subpaths and
types never reach npm even though a caret range admits the new server
(the repo has hit exactly this before).

**Tests** (in `packages/server`, discovered by the existing wiring):

1. **Render matrix** — one case per `FunctionComponentResult` shape plus the
   security regressions: raw string in `Child[]`, `Promise<string>` in
   `Child[]` (both asserted **escaped**), nested async, `memo`,
   `ErrorBoundary`, context-provider root; every case asserts a primitive
   `string` (the boxed-`String` wart is invisible to `toEqual`).
2. **Response contract** — `text/html; charset=utf-8`, leading
   `<!doctype html>`, `status`/`headers`/`doctype: false` honoured, no
   `__INERTIA_PAGE__` in the body, and the fragment guard: a Layout-less
   component throws the descriptive error; the same component with
   `{ doctype: false }` succeeds.
3. **Escaping boundary** — breakout inputs asserted escaped; a `javascript:`
   href asserted **passed through**, pinning what `view()` does not promise.
4. **Runtime chain** — a fixture app resolving the pragma through
   `@guren/core/jsx-runtime` compiles (`tsc`) and renders; mirrors the
   two-level fake-package chain measured for this RFC.
5. **`viteAsset()`** — dev branch, manifest branch, and the loud error when
   neither resolves.
6. **Error propagation** — a throwing component propagates to
   `ExceptionHandler` like any throwing action (assert, don't assume).

**Docs items** (shipped with the feature, not after):

- The Layout head rule (charset/viewport/stylesheet only) and why — the
  dedupe semantics above.
- JSON-LD needs `dangerouslySetInnerHTML` with `<` escaped as `\u003c`.
- URL schemes are not sanitized; compose with `@guren/plugin-markdown` for
  user-supplied content (its sanitizer is the scheme allowlist).
- Tailwind: v4's automatic source detection already scans `app/View/`
  (templates ship v4); apps still on v3-style `content` globs must add
  `./app/View/**/*.tsx`. `view()` pages carry no Vite client, so no HMR —
  edit-refresh, by design.
- `bunx guren check --arch` rule example for the pages→View boundary.

**Out of scope, deliberately:** `make:content-page` scaffolding, sitemap/RSS/
robots helpers, and `viewStream()` over `hono/jsx/streaming` (the natural
follow-up; note its error story differs — bytes already flushed cannot be
retracted). Each is a small additive PR once `view()` is real.

**Dogfooding order:**

1. Implement in-workspace; migrate `web/modules/blog`'s show page
   (`resources/js/pages/blog/Show.tsx` → `app/View/`). Verified mostly
   portable: its `<Seo>` emits `<title>`/`<meta>`/`<link>` which hoist
   unchanged; only the JSON-LD block needs the `dangerouslySetInnerHTML`
   treatment, and the page must render a full document. The docs Show page
   is **not** a target — scroll-spy TOC, mobile sidebar, SPA nav make it an
   islands problem this RFC does not solve.
2. Release server + core.
3. Migrate the motivating external application, deleting its `renderPage()`
   and `escapeHtml()`.
4. Only then: reference `view()` from templates and guides
   (`smoke:starter:npm` is the gate that is correctly red in between).

## Alternatives Considered

- **Ship as `@guren/plugin-content` (this RFC's original form).** Rejected by
  maintainer decision after review. What the pivot dissolved, concretely: the
  plugin needed hono as a carefully-ranged runtime peer because it rendered
  outside the package that owns hono (two revisions of dependency-shape
  churn, including a floor correction); it could not deliver asset resolution
  at all, because the manifest logic lives in `@guren/server` and touching it
  broke the plugin's additive premise; and apps had to declare hono
  themselves for the pragma. Built in, each of those is either structural
  (copy identity via the subpath chain) or a normal minor release. The cost
  accepted in exchange: `view()` becomes permanent public API on
  `Controller` — a plugin could have been deprecated.
- **Route through `ViewEngine.register()`.** Structurally impossible without
  widening a published type; see Verified constraints.
- **Keep using `this.inertia()` for public pages.** Rejected on the measured
  67% / 33.7%-gzip numbers above, plus the Inertia SSR pipeline being bundled
  into deploy targets that only need it for an admin surface (661 KB →
  1,106 KB gzip on the motivating Workers deploy).
- **Keep hand-writing `renderPage()`.** The status quo being absorbed; its
  failure mode is the forgotten `escapeHtml()`.
- **Take a JSX element instead of component + props**
  (`view(<PostPage post={post} />)`). Forces every controller to become
  `.tsx` with a pragma, and loses call-site prop inference. Rejected.
- **Invoke the component directly and reduce by hand** to avoid a runtime
  hono import. Rejected on the measured stored-XSS hole (raw strings in
  `Child[]` bypass escaping); reimplementing hono's escaping to save an
  import is not a trade.
- **A bespoke Blade/ERB-style template language.** Parser, compiler, caching,
  editor tooling — for an audience that already writes JSX, when the JSX
  engine is already installed. Rejected.
- **`jsxRenderer()` middleware as the layout mechanism** instead of a plain
  `Layout` component. Prototyped end to end and it works — but hoisting works
  identically without it, so its contribution is a layout convention plus
  request access in components, at the cost of magic (`c.render` indirection,
  module augmentation for typed props). A plain component the page wraps
  itself in is explicit, and the middleware bridge remains addable later
  without touching `view()`'s signature.

## Migration Path

Purely additive; nothing breaks. Existing apps see two new methods and two
new subpaths after upgrading `@guren/server` + `@guren/core`. Apps hand-
rolling `renderPage()` migrate controller-by-controller; `this.inertia()`
remains the right choice for interactive routes (the motivating app keeps its
`/admin/posts` editor on Inertia).

## Resolved Questions

Settled by maintainer decision on 2026-08-25, grounded in the measurements
above.

1. **Hydrating vs. server-only JSX convention** — directory split
   (`app/View/`, forced independently by codegen's `pagesDir` claim) plus a
   documented `guren.arch.ts` rule; no new `guren check` code. `tsc` already
   rejects the confusions worth rejecting except two narrow shapes, both
   documented above.
2. **Scope** — `view()` + `viteAsset()` + the runtime subpaths, nothing else.
   No configuration object anywhere: an earlier revision shipped a
   `contentPlugin({ siteName, siteUrl })` whose config nothing read — dropped
   rather than speculatively bound. Sitemap/RSS/robots and `viewStream()` are
   follow-ups with their own designs.
3. **JSX runtime exposure** — `@guren/core/jsx-runtime`, reversing this RFC's
   earlier conclusion. The earlier finding stands technically — a *barrel*
   re-export cannot satisfy a `jsxImportSource` pragma (`TS2875`; the pragma
   resolves `X/jsx-runtime`, never `X`) — but the *subpath* form works
   (two-level chain verified), and moving `view()` into the framework gave it
   what it lacked before: a reason to exist. It removes the app-side hono
   dependency and makes runtime copy identity structural.
4. **Document contract** — Layout is a plain component the page wraps itself
   in (option (a)); native hoisting owns metadata placement; `viteAsset()`
   owns asset URLs (option (ii) — the framework change is accepted, which is
   what the pivot to built-in made possible); the fragment guard in `view()`
   catches the forgotten-Layout case loudly. `lang` stays a Layout prop for
   v1; threading the request locale the way `inertia()` does is a candidate
   follow-up once i18n'd content pages exist in practice.
