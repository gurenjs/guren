# RFC: Non-Inertia Content Rendering Plugin (`@guren/plugin-content`)

**Author:** 7nohe
**Date:** 2026-08-22
**Status:** Draft (discussion opens 2026-08-22; minimum two-week window per
`contributing/rfc-process.md`, so the earliest decision date is 2026-09-05)

> Additive: a new plugin package plus a `ContentController` base class it
> exports. No changes to `@guren/core`, `@guren/server`, or any existing
> public API — `view()` lives on the plugin's own subclass, not on the
> framework's `Controller`.

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
escaped JSON, once as HTML. SSR that fails — no renderer, invalid output, a
thrown error — falls back to the empty CSR shell, which leaves the JSON copy
alone rather than doubling it. Measured on 2026-08-22 while migrating a real Guren app off Inertia
for its public pages (a personal blog: 21 posts, Shiki syntax highlighting).
These numbers come from that application, not from a fixture in this
repository, and are reproducible only there:

| | largest post |
|---|---|
| `__INERTIA_PAGE__` (JSON) | 238 KB |
| full page, Inertia SSR (measured) | 443,392 bytes |
| full page, plain SSR HTML (measured) | 144,241 bytes |

Plain SSR HTML was **67% smaller** than the Inertia-rendered equivalent for
the same content, and rendering it required no client JS at all — readers
get no framework, so nothing needs hydrating and the response can be smaller
than what Inertia's own baseline (non-SSR, empty page shell) produces once a
real article's props are attached.

**The framework has no ergonomic way to return server-rendered HTML from a
controller.** `Controller` has `this.inertia(...)` and nothing else that
produces a page. In practice this pushed the migrated app to hand-write a
`renderPage(options, body): Response` free function that string-concatenates
HTML, with a hand-rolled `escapeHtml()` the author has to remember to call at
every interpolation site. That is the same "dogfood, then absorb" gap
`@guren/plugin-markdown` (RFC 0012) closed for markdown rendering — every app
that wants public content pages has to rediscover the same shape, and here
the failure mode of forgetting `escapeHtml()` is a stored-XSS bug, not a
cosmetic one.

An earlier draft of this RFC claimed `ViewEngine.register()` was the right
extension point that merely lacked a controller-side entry. That is wrong,
and the reason is in the next section: `ViewEngine` structurally cannot carry
this feature. The hand-written `renderPage()` bypass was forced, not lazy.

## Verified constraints (2026-08-22)

Every claim below was read out of this repository's sources or measured with
a fixture, not assumed. The first draft of this RFC was written against
`node_modules/@guren/server` in the consuming application; several of its
API claims did not survive contact with the real sources.

### `ViewEngine` cannot render a component

`packages/server/src/mvc/ViewEngine.ts` in full is a `Map<string,
ViewRenderer>` where:

```typescript
export type ViewRenderer = (template: string, props: Record<string, unknown>) => Response | Promise<Response>
```

The template is a **string**. An `FC` is a function. Routing
`view(Component, props)` through `ViewEngine.register()` would require
widening a published type in `@guren/server`, which contradicts this RFC's
additive premise. `ViewEngine` has exactly one registration in the entire
repository (`InertiaServiceProvider` registering `'inertia'`) and no
`Controller` method reads from it. **This RFC does not touch `ViewEngine`.**

### `hono/jsx`'s real surface

Read from `hono@4.13.1` as resolved by `packages/server`:

- `FC<P = Props>` is `{ (props: P): FunctionComponentResult; defaultProps?; displayName? }`,
  where `FunctionComponentResult = HtmlEscapedString | Child[] | Promise<HtmlEscapedString | Child[]> | null`.
  **A component does not return a string**, so `view()` must reduce four
  shapes, not one.
- `hono/jsx` exports `FC`, `Child`, `JSXNode`, `PropsWithChildren`, `RefObject`,
  `Context` as types. It does **not** export `Props`. The first draft's
  `import { createElement, type FC, type Props } from 'hono/jsx'` fails to
  compile with `TS2614: Module '"hono/jsx"' has no exported member 'Props'`
  (verified with `tsc` 7.0.2). `Props` is declared in `hono/jsx/base`, which
  hono's own `exports` map does not publish — there is `./jsx`,
  `./jsx/jsx-runtime`, `./jsx/streaming` and friends, but no `./jsx/base`. So
  it is unreachable, not merely discouraged.
- `renderToReadableStream` lives at `hono/jsx/streaming`, not `hono/jsx`.

### `hono` is not reliably resolvable from application code

The first draft claimed `hono/jsx` is "already a transitive dependency of
every Guren app". That is true only under a **hoisting** installer, and it is
a phantom dependency even then:

| context | `import.meta.resolve('hono/jsx')` |
|---|---|
| `packages/server` (declares `hono`) | resolves, 4.13.1 |
| `packages/core`, `packages/cli`, `packages/plugin-markdown` | **fails** |
| `examples/blog` (a real Guren app in this repo) | **fails** |
| a scratch app with `npm install @guren/core` | resolves, hoisted, 4.13.3 |

This repository uses bun's isolated linker (`node_modules/.bun/...`), so only
the declaring package sees `hono`. A published app installed with npm gets it
hoisted. **A plugin therefore cannot rely on ambient resolution** — it must
declare `hono` itself, and a plain `dependencies` entry risks a second copy
in one process, the same hazard `.claude/rules/common-pitfalls.md` records
for drizzle.

### Stringifying a component tree has two traps

Measured against `hono@4.13.3` with Bun 1.3.14:

- `String(node)` throws **`TypeError: No default value`** whenever the tree
  contains a nested async component (a sync parent with an async child — the
  ordinary shape once any component awaits). Naive stringification is not
  merely lossy, it throws at runtime.
- `await createElement(C, props).toString()` on an **async root** returns a
  boxed `String` object, not a primitive (`typeof === 'object'`). The first
  draft's `const html = await element.toString()` produces this. It happens to
  survive `new Response()`, but it is not the declared `string`.

Two earlier revisions of this RFC proposed reducing the result **by hand**, so
that the plugin could invoke the component directly and keep `hono` a
type-only import:

```typescript
// REJECTED — this reduction has a stored-XSS hole. Kept here because the
// reasoning that produced it is easy to repeat.
async function stringify(node: unknown): Promise<string> {
  const value = await node
  if (Array.isArray(value)) return (await Promise.all(value.map(stringify))).join('')
  if (value == null || typeof value === 'boolean') return ''
  return String(await (value as { toString(): string | Promise<string> }).toString())
}
```

`Child` legally includes `string` and `Promise<string>`, and hono escapes
those when it walks children itself. The hand-written reducer calls
`String()` on them instead, so a component returning a raw string inside a
`Child[]` emits it **unescaped**:

| component returns | hand-reduced | `createElement(...).toString()` |
|---|---|---|
| `['<script>alert(1)</script>', <p>ok</p>]` | `<script>alert(1)</script><p>ok</p>` | `&lt;script&gt;alert(1)&lt;/script&gt;<p>ok</p>` |
| `[Promise.resolve('<b>raw</b>'), <p>ok</p>]` | `<b>raw</b><p>ok</p>` | `&lt;b&gt;raw&lt;/b&gt;<p>ok</p>` |

That is a stored-XSS path in the one API whose entire selling point is that
it escapes by default, and no earlier fixture caught it because they only
ever put `JSXNode`s in the array. **The correct form is to let hono own the
reduction**, which also removes every trap listed above:

```typescript
async function render<P>(component: FC<P>, props: P): Promise<string> {
  return String(await createElement(component as never, props as never).toString())
}
```

Verified to return a primitive `string` with correct escaping for: sync
roots, async roots, `Child[]` containing raw strings and promises, nested
async children, `null`, `memo()`, `ErrorBoundary`, and a root that is itself
a context provider.

- hono/jsx emits **no doctype**. `view()` must prepend `<!doctype html>` or
  every page renders in quirks mode. The first draft did not.

### hono/jsx hoists `<title>`, `<meta>` and `<link>` into `<head>` on its own

Three revisions of this RFC asserted that hono/jsx "is a single top-to-bottom
string buffer with no portal primitive", so head data must be threaded to the
Layout as explicit props. **That is wrong.** hono/jsx implements React-19-style
metadata hoisting (`jsx/intrinsic-element/components.js`, `insertIntoHead`),
and it works through plain `createElement` with no middleware:

| element rendered deep inside `<body>` | lands in `<head>` |
|---|---|
| `<title>` | **yes** |
| `<meta>` | **yes** |
| `<link>` (incl. `rel="canonical"`, RSS `alternate`) | **yes** |
| `<script type="application/ld+json">` | no — stays in place |
| `<style>` | no — stays in place |

Two conditions and one trap:

- The rendered output must **contain a `<head>`**. The implementation looks
  for `</head>` in the buffer, so a fragment gets no hoisting: a `<title>`
  inside a `<div>` renders as `<div><title>…`. A content component that
  renders a whole document is fine; one that renders a body fragment is not.
- JSON-LD passed as a **text child is HTML-escaped**, which breaks it:
  `{"@type":"Article"}` becomes `{&quot;@type&quot;:&quot;Article&quot;}`.
  It needs `dangerouslySetInnerHTML` with `<` escaped as `\u003c`, the same
  treatment every framework gives inline JSON.

This substantially shrinks Open Question 4. `<Seo>`'s title, description,
canonical link, RSS alternate, OpenGraph and Twitter tags are all
`<title>`/`<meta>`/`<link>`, so they hoist unchanged; only its JSON-LD block
needs the `dangerouslySetInnerHTML` treatment.

### The peer floor cannot be `4.12.0`

`FunctionComponentResult` — the four-shape union this RFC quotes throughout —
**was introduced in hono 4.13.0**. Unpacked from the registry: `hono@4.12.29`
declares no such type and its `FC` returns the narrower
`HtmlEscapedString | Promise<HtmlEscapedString> | null`. An earlier revision
set the peer range to `>=4.12.0 <5.0.0` on the reasoning that it should match
`@guren/server`'s `^4.12.29`; that range admits versions whose component
contract the design does not describe. The floor is **`>=4.13.0`**, and it
must be tested against 4.13.0 itself rather than only the 4.13.1/4.13.3
copies this workspace happens to resolve.

Note `audit:plugin-compat` does not cover this: it audits the `@guren/core`
`compatibility` claim, not third-party peer ranges.

### What auto-escaping does and does not cover

This matters more than the byte counts, because the RFC's pitch is that
`view()` retires a hand-rolled `escapeHtml()`. Measured:

| input | rendered |
|---|---|
| `{'<script>alert(1)</script>'}` as a text child | `&lt;script&gt;alert(1)&lt;/script&gt;` |
| `href={'" onmouseover="alert(1)'}` | `href="&quot; onmouseover=&quot;alert(1)"` |
| `href={'javascript:alert(1)'}` | **`href="javascript:alert(1)"` — passed through** |

So hono/jsx prevents **tag and attribute breakout**, which is exactly the
class of bug a forgotten `escapeHtml()` causes, and that claim stands. It
does **not** sanitize URL schemes: a `javascript:` or `vbscript:` href built
from user data is emitted verbatim. An earlier draft of this RFC's test plan
asserted such URLs would be "escaped"; that was wrong, and the plugin must
instead document scheme validation as the caller's job (or offer a helper).
`@guren/plugin-markdown`'s sanitizer already restricts `href`/`src` to
`http`/`https`/`mailto`, which is the right precedent to point at.

One further silent shape, found while enumerating the type-safety gaps
below: a React-shaped element placed as an **expression child** inside a hono
element (`<div>{reactElement}</div>`) type-checks, because intrinsic props
are `Record<string, any>`, and renders as **`<div></div>`** — the content is
dropped with no error at compile time or runtime.

### Async context degrades silently without AsyncLocalStorage

`hono/jsx/context.js` falls back to a module-level variable when
`AsyncLocalStorage` is unavailable, and warns that `useContext()` **after an
`await` in an async component returns the context default value** during SSR.
A content page whose async child reads a locale or theme context would
silently render the wrong value rather than fail.

Guren's own Cloudflare path is not exposed: `packages/plugin-cloudflare`
writes the `nodejs_compat` flag, and `web/wrangler.jsonc` carries it. But an
app that hand-rolls its Workers config, or any runtime without ALS, is. The
plugin should document this rather than discover it in production.

### JSX pragma behaviour under TypeScript 7

`packages/create-app/templates/default/tsconfig.json` sets `"jsx":
"react-jsx"` with no `jsxImportSource` (so, `react`), and its `include`
covers both `app/**/*` and `resources/js/**/*` — one program, one JSX
setting. Verified with `tsc` 7.0.2 (`tsgo`) against an app-shaped fixture
carrying both `react@19.2.8` and `hono@4.13.3`:

| fixture | result |
|---|---|
| hono `FC`, **no** pragma | `TS2322: Type 'Element' is not assignable to type 'FunctionComponentResult'` |
| hono `FC`, `/** @jsxImportSource hono/jsx */` | **compiles clean** |
| React component passed to `view(component, props)` | `TS2345: ... not assignable to parameter of type 'FC<...>'` |
| wrong prop name at a `view()` call site | `TS2561: ... 'titel' does not exist` |
| `FC`-annotated content component imported by a React page | `TS2786: cannot be used as a JSX component` |
| **pragma'd component with no `FC` annotation, imported by a React page** | **compiles silently** |

So the per-file pragma works as the first draft claimed, and — more
importantly — the type system already rejects every confusion between the two
JSX runtimes **except one narrow shape**. That single residual gap drives the
answer to Open Question 1.

### `jsxImportSource` needs runtime subpaths, not a barrel re-export

A `jsxImportSource: "X"` pragma makes the compiler import from
`X/jsx-runtime` and `X/jsx-dev-runtime` — never from `X` itself. Verified
with two fixture packages:

| package shape | result |
|---|---|
| `exports: { "." }` re-exporting `hono/jsx` | `TS2875: This JSX tag requires the module path '@fake/rootonly/jsx-runtime' to exist` |
| `exports` adding `./jsx-runtime` + `./jsx-dev-runtime` | compiles clean |

`packages/server/src/index.ts` is a barrel of named exports and
`packages/server/package.json` declares no `jsx-runtime` subpath. Adding
`hono/jsx` to that barrel — the shape Open Question 3 imagines — would
therefore **not** let anyone write `jsxImportSource: "@guren/server"`. This
reframes Open Question 3 entirely.

### Packaging facts

- Workspace versions: `@guren/core` 1.8.1, `@guren/server` 2.10.1,
  `@guren/testing` 1.6.2, `@guren/plugin-markdown` 0.2.1.
- `@guren/core` re-exports `Controller`, `ViewEngine`, and `definePlugin`;
  `definePlugin<TConfig>(definition) => (config: TConfig) => ServiceProviderConstructor`
  matches the first draft's usage exactly.
- New packages need no build or test wiring: `scripts/build-packages.ts` and
  `scripts/test-packages.ts` discover them automatically.
- `audit:plugin-compat` requires first-party plugins to declare
  `gurenPlugin.compatibility`.
- `defineArchRules()` from `@guren/cli/arch` supports
  `{ from, disallow, includeTypeImports, severity }` over project-relative
  globs — the mechanism that closes the one residual type-safety gap above.

### The proposed implementation was executed, not just written

The `ContentController.view()` body quoted in "Proposed Solution" is
transcribed from working fixtures, not sketched. Three runs, and what each did
and did not cover. Note the first two were run against the **rejected**
direct-call form; they are reported here because they establish the response
contract, which the correction did not change:

- **Rendering behaviour**, on Bun 1.3.14 against a page with a nested async
  child and a `<script>`-bearing prop: status 200, `content-type: text/html;
  charset=utf-8`, output beginning `<!doctype html>`, the script tag escaped,
  no `__INERTIA_PAGE__`, the async child rendered, and `{ doctype: false,
  status: 404, headers }` all honoured. Compiled with `tsc` 7.0.2 under a
  tsconfig carrying the create-app template's `jsx: "react-jsx"` and strict
  settings, but not identical to it: the fixture adds `lib` and
  `allowImportingTsExtensions` and omits `types: ["bun-types", "vite/client"]`,
  none of which bear on JSX resolution. This fixture used a local stand-in
  base class, so it proves the rendering contract, not the inheritance.
- **The corrected `createElement` render**, on Bun 1.3.14: returns a primitive
  `string` with correct escaping for sync roots, async roots, `Child[]`
  containing raw strings and promises, nested async children, `null`,
  `memo()`, `ErrorBoundary`, and a root that is itself a context provider.
  This is the run that found the rejected reduction's escaping hole.
- **Inheritance from the real base**, in-repo against `@guren/core`'s actual
  `Controller`: `class ContentController extends Controller` with the `view()`
  body above type-checks clean, and a subclass instantiated **without
  `setContext()`** returns the expected response. This matters because
  `Controller`'s `ctx` getter throws when no context has been set; `view()`
  never reads `ctx`, so a content controller is usable outside the router's
  normal lifecycle. Nothing in `Controller`'s private state or its
  `setContainer()` DI contract obstructs the subclass.

## Proposed Solution

A new workspace package `packages/plugin-content`, published as
`@guren/plugin-content`. It exports exactly two things:

1. `ContentController` — a `Controller` subclass adding `view()`.
2. `contentPlugin()` — a `definePlugin()` factory binding shared page
   configuration into the container.

It reuses `hono/jsx` rather than inventing a template DSL (Blade/ERB-style
compilation). `hono/jsx` gives auto-escaping-by-default interpolation,
composable layout/partial components, and syntax every Guren app author
already knows from writing Inertia pages, for the cost of wiring an existing
dependency instead of building and maintaining a parser, compiler, and editor
tooling for a new language.

### `ContentController`

```typescript
// packages/plugin-content/src/ContentController.ts — plain .ts, no JSX syntax
import { Controller } from '@guren/core'
import { createElement, type FC } from 'hono/jsx'

export interface ViewOptions {
  status?: number
  headers?: HeadersInit
  /** Prepend `<!doctype html>`. Default true; set false for fragment responses. */
  doctype?: boolean
}

export abstract class ContentController extends Controller {
  protected async view<P>(component: FC<P>, props: P, options: ViewOptions = {}): Promise<Response> {
    // Build a real hono element and let hono reduce it. Invoking the
    // component directly and reducing by hand looks equivalent and is not:
    // it skips hono's escaping of raw strings inside a `Child[]`. See
    // "Stringifying a component tree" above.
    const body = String(await createElement(component as never, props as never).toString())
    const headers = new Headers(options.headers)
    if (!headers.has('content-type')) headers.set('content-type', 'text/html; charset=utf-8')
    return new Response((options.doctype === false ? '' : '<!doctype html>') + body, {
      status: options.status ?? 200,
      headers,
    })
  }
}
```

The two `as never` casts are load-bearing and unavoidable: `createElement`'s
declared parameter type is `Props = Record<string, any>`, which `hono/jsx`
does not export, so there is no name to cast to. The safety boundary is
`view()`'s own generic signature — `component` is `FC<P>` and `props` is `P`,
checked at the call site — and the casts only bridge to hono's deliberately
loose internal signature. An earlier revision claimed the design needed no
cast at all; that was true only of the direct-call form this RFC now rejects.

### What `view()` deliberately does not do, and why that is the open design risk

`view()` returns a doctype plus whatever the component rendered. That is a
much thinner contract than `this.inertia()`, and the difference is not
cosmetic. `InertiaEngine` assembles a whole document: the `<html lang>`
attribute, `<head>`, critical CSS, stylesheet links, an import map, and
`<body>` class attributes. `Controller.inertia()` additionally resolves
shared Inertia props and the request locale before rendering.

Under this proposal all of that becomes the app's `Layout` component's job,
and three specific capabilities have no replacement at all:

1. **Head hoisting — mostly a non-issue, corrected.** Earlier revisions listed
   this as the hardest gap. Measured, hono/jsx hoists `<title>`, `<meta>`, and
   `<link>` into `<head>` from anywhere in the tree by itself (see "hono/jsx
   hoists…" above). What remains is narrow: `<script>` and `<style>` do not
   hoist, JSON-LD needs `dangerouslySetInnerHTML`, and the component must
   render a document containing a `<head>` rather than a bare fragment. Those
   are documentation items, not design gaps.
2. **Locale.** `Controller`'s `locale`, `t`, and `tc` helpers read the
   request context, and `inertia()` passes the resolved locale through as
   `lang`. `view()` never touches `ctx`, so a content page gets no locale
   unless the controller passes one in as a prop. This is the real remaining
   gap, and it is small: `view()` could resolve `lang` the way `inertia()`
   does.
3. **Assets.** Nothing injects the stylesheet or import map that the Vite
   pipeline produces. The existing resolver is Inertia-specific — it
   hard-codes `resources/js/app.tsx` and publishes only `GUREN_INERTIA_*`
   values — so there is no framework-supported way for a content Layout to
   ask for its assets today. This, not head composition, is the question with
   real design weight.

For the motivating application this was acceptable: it had already
hand-written a `renderPage()` that owned the whole document. Four options,
in increasing scope:

- **(a) Document it as the Layout's job.** Ship `view()` as specified, with a
  reference `Layout` in the README showing head, lang, and asset wiring. The
  app owns the document, the plugin owns escaping and the response.
- **(b) Add a `head` option** to `ViewOptions` — a typed record of title,
  meta, links, and JSON-LD that `view()` serialises into `<head>`, with the
  component rendering only `<body>` content. Solves head composition without
  a portal, at the cost of a second, non-JSX way to express markup.
- **(c) Add a `document` seam**: `view()` takes an optional outer component
  receiving `{ lang, head, body }`, and the plugin resolves `lang` from the
  request context the way `inertia()` does. **Incomplete as sketched**: by the
  time `body` is a string, rendering it as `{body}` in hono JSX escapes the
  whole page, so it needs `raw()` or a retained node — and the seam says
  nothing about where `head` comes from, so it does not by itself solve
  hoisting.
- **(d) Bridge hono's own `jsxRenderer()`.** hono ships a
  `hono/jsx-renderer` middleware that installs a request-scoped renderer,
  supplies a Layout, adds the doctype, exposes the request through
  `useRequestContext()`, and has a `stream` option. A plugin provider can
  attach middleware through the container's `hono` binding. Prototyped and
  working end to end (doctype, `<html lang>`, typed Layout props via
  `ContextRenderer` augmentation, escaping, and hoisting all correct).
  **But note what it does *not* contribute:** hoisting works identically
  without it. Its real value is a Layout convention, request access inside
  components, and streaming — so it competes with (a) on ergonomics, not on
  capability.

**No recommendation, deliberately.** An earlier revision recommended (a);
option (d) had not been considered at that point and may dominate it. See
Open Question 4.

**Assets are more constrained than any of these admit.** The existing
manifest resolver is Inertia-specific: it hard-codes `resources/js/app.tsx`
and publishes only `GUREN_INERTIA_*` values. A reference Layout cannot
demonstrate framework-supported asset injection without hard-coding URLs or
reaching into Inertia-named internals. Either a generic Vite asset descriptor
gets factored out, or v1 states plainly that assets are an application input.

### Dependency shape

`hono` is declared as a **peer dependency**, and the plugin imports it at
**runtime** (`createElement`), not type-only:

```json
"peerDependencies": { "hono": ">=4.13.0 <5.0.0" }
```

An earlier revision made this a type-only import and argued that the plugin
therefore shipped no hono runtime code, so two copies could never meet inside
it. That argument is gone with the direct-call design that motivated it: the
plugin must build a real hono element to get hono's escaping, so it imports
hono for real. What survives, and why a peer is still the right mechanism:

- **The peer range is explicit rather than relying on hoisting**, so the
  plugin resolves under bun's isolated linker and under pnpm, not only under
  npm's hoisted layout. `examples/blog` failing to resolve `hono/jsx` is what
  makes this necessary rather than pedantic.
- **A peer resolves to the application's own copy**, which is exactly what the
  two-copies concern demands. A plain `dependencies` entry would let the
  plugin install a second hono beside the app's, and now that the plugin
  builds `JSXNode`s that the app's components populate, a split really would
  matter — hono's context machinery and its escaping helpers are
  module-scoped. This is the drizzle hazard, and the peer is the fix.
- **The published `.d.ts` references `hono/jsx`'s `FC`**, which a consumer
  must be able to resolve. A declared peer guarantees that.

The floor is `4.13.0` because that is where `FunctionComponentResult` appears
(see "The peer floor cannot be `4.12.0`"). Note this is *higher* than
`@guren/server`'s own `^4.12.29`, which is fine — they are independent
ranges over the same package, and any install satisfying both lands on
4.13.0 or later.

Neither npm nor bun installs a peer dependency silently in every
configuration, and a peer outside its range is a warning rather than a hard
failure. The plugin should therefore fail loudly at first use if
`createElement` is missing or the resolved hono is too old, rather than
producing subtly wrong output. That check is cheap and belongs in v1.

### `contentPlugin()`

```typescript
// packages/plugin-content/src/plugin.ts
import { definePlugin, type ServiceProviderConstructor } from '@guren/core'

export interface ContentPluginConfig {
  siteName: string
  siteUrl: () => string
}

const factory = definePlugin<ContentPluginConfig>({
  name: 'content',
  register(container, config) {
    container.instance('content.config', config)
  },
})

export function contentPlugin(config: ContentPluginConfig): ServiceProviderConstructor {
  return factory(config)
}
```

Not deferred, for the reason RFC 0012 records after amending itself: a
deferred service cannot be resolved with a plain synchronous
`container.make()` until its loader has been awaited, and binding a config
object is trivial.

Note `view()` does **not** require the plugin to be registered. A controller
can extend `ContentController` in an app with no `providers` change at all;
`contentPlugin()` exists for apps that want shared page metadata in the
container and for the `guren plugin @guren/plugin-content` install flow.
This mirrors `@guren/plugin-markdown`, where `createMarkdownRenderer()` is
the primary API and the provider is a thin convenience.

### Usage

```tsx
// app/View/PostPage.tsx — the only file in the app that needs JSX syntax
/** @jsxImportSource hono/jsx */
import type { FC } from 'hono/jsx'
import type { PostRecord } from '../Models/Post.js'
import { Layout } from './Layout.js'

export const PostPage: FC<{ post: PostRecord }> = ({ post }) => (
  <Layout title={`${post.title} | example.com`}>
    <article dangerouslySetInnerHTML={{ __html: post.contentHtml }} />
  </Layout>
)
```

```typescript
// app/Http/Controllers/BlogController.ts — stays plain .ts, zero JSX syntax
import { ContentController } from '@guren/plugin-content'
import { PostPage } from '../View/PostPage.js'
import { Post } from '../Models/Post.js'

export default class BlogController extends ContentController {
  async show() {
    const post = await Post.findOrFail(/* ... */)
    return this.view(PostPage, { post }) // component + props, not a JSX element
  }
}
```

Passing the component and props separately, rather than a constructed JSX
element, is what keeps controllers as plain `.ts` with no pragma and no JSX
syntax. It is also what makes the call site type-check: see below.

### Why this keeps end-to-end type safety without codegen

`view<P>(component: FC<P>, props: P)` infers `P` from the real, imported
function type of `component` — ordinary TypeScript generic inference.
Changing `PostPage`'s prop shape breaks every `this.view(PostPage, ...)` call
site at `tsc` time, with IDE rename-refactor following through to the
controller. Verified: a `titel`/`title` typo at a call site is `TS2561`.

This is a stronger guarantee than the Inertia page-prop story, which needs
`bunx guren codegen` to read each page's `interface Props` and regenerate
`PagePropsMap` before `this.inertia(pages.posts.Show, props)` type-checks
against it — a known staleness window. Because `PostPage` is a plain imported
value rather than a codegen-resolved string key, there is no generation step
and no window in which the types can go stale. `guren check`'s route ↔
controller ↔ page consistency check has nothing new to verify for this path.

The first draft justified a `props as Props` cast inside `view()`. With the
direct-call implementation there is no cast at all: `component` is `FC<P>`
and `props` is `P`, so `component(props)` is checked normally. The looseness
of `createElement`'s own signature never enters the picture.

### JSX import source

Project `tsconfig.json`s created by `create-app` set `"jsx": "react-jsx"`
with no explicit `jsxImportSource` (implicitly `react`), because Inertia
pages under `resources/js/pages/` need React's JSX runtime. A file using
`hono/jsx` in the same project needs the per-file pragma:

```tsx
/** @jsxImportSource hono/jsx */
```

Verified against `tsc` 7.0.2 and Bun 1.3.14: both honour the per-file
override, and omitting it is a compile error rather than a silent
mis-compile. No second `tsconfig.json` or separate build target is needed.
Apps must also add `hono` to their own `dependencies` — the pragma resolves
from the app's tree, and relying on hoisting is what the resolution table
above warns against. A future `bunx guren make:content-page` scaffold (out of
scope for this RFC) would emit the pragma and the `FC` annotation
automatically.

## Implementation Plan

### Package layout

Mirrors `packages/plugin-markdown` file-for-file where the shapes correspond:

```
packages/plugin-content/
├── package.json            # gurenPlugin manifest, peer on hono
├── tsconfig.json           # workspace-resolved, for `typecheck`
├── tsconfig.build.json     # layers tsconfig.build-base.json (paths: {}) — see below
├── tsdown.config.ts        # spreads tsdownPreset from scripts/tsdown-preset.ts
├── README.md
└── src/
    ├── index.ts            # export { contentPlugin, ContentController, type ... }
    ├── plugin.ts           # definePlugin() factory           ~ plugin-markdown/src/plugin.ts
    ├── ContentController.ts# the Controller subclass          (no counterpart)
    ├── render.test.ts       # escaping + result-shape matrix
    ├── ContentController.test.ts
    └── plugin.test.ts      #                                  ~ plugin-markdown/src/plugin.test.ts
```

`tsconfig.build.json` is required, not optional: `ContentController.ts`
imports `@guren/core`, a sibling package. Per
`.claude/rules/common-pitfalls.md`, a package whose sources import a sibling
must point tsdown at a config layering `tsconfig.build-base.json` so
`paths: {}` resolves the sibling through `node_modules` to its built
declarations. Otherwise the native declaration emitter scatters `.d.ts` files
beside the sibling's sources and `scripts/build-packages.ts` fails the build.
`bun run build:list` must show `@guren/core` ahead of `@guren/plugin-content`.

### `gurenPlugin` manifest

```json
{
  "name": "@guren/plugin-content",
  "version": "0.1.0",
  "type": "module",
  "gurenPlugin": {
    "compatibility": ">=1.0.0 <2.0.0"
  },
  "files": ["dist"],
  "exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } },
  "scripts": {
    "build": "bun --bun tsdown",
    "test": "bun test",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": { "@guren/core": "^1.8.1" },
  "peerDependencies": { "hono": ">=4.13.0 <5.0.0" },
  "devDependencies": { "hono": "^4.13.1", "tsdown": "^0.22.14", "typescript": "^7.0.2" }
}
```

**The `scripts` block is not boilerplate — omitting it silently disables the
package.** `scripts/build-packages.ts` filters the workspace to packages with
a `scripts.build`, and `scripts/test-packages.ts` to those with a
`scripts.test`. An earlier revision of this RFC showed a manifest with no
`scripts` at all while claiming build and test discovery are automatic. Both
claims are true, and together they meant the package and all three of its
test files would have been skipped without a single error. Confirm by
checking the package appears in **both** `bun run build:list` and
`bun run test:bun:list` before trusting a green run.

`compatibility` tracks the `@guren/core` 1.x line, matching
`@guren/plugin-markdown` and the deploy plugins; `audit:plugin-compat`
enforces its presence and keeps it honest against future releases. No
`provider` field — the primary export is a `definePlugin()` factory, and
per `contributing/plugin-contract.md` the CLI must not guess a class name for
those. No `commands` entry: the plugin ships no CLI commands. `hono` is
**not** a normal dependency, for the reasons in "Dependency shape".

Whether `@guren/plugin-content` joins the CLI's official zero-config
auto-registration table is deliberately left out: `contentPlugin(config)`
requires `siteName`/`siteUrl`, so it is not zero-config and does not qualify.

### Testing

`createPluginTestApp()` exists in `@guren/testing` and is the right tool for
**one third** of this. Its signature is
`createPluginTestApp(providers: unknown[]): Promise<Application>` — it boots
`createApp` and proves container registration, nothing more. It cannot
exercise `view()`, which needs a controller context. Note also that
`plugin-markdown`'s own test does not use it, preferring a bare `Container` +
`ProviderManager`; the new package should follow whichever it can actually
run in-package without a dependency on `@guren/testing`.

Three test layers:

1. **`render.test.ts` — the shape matrix, and the security regression.** One
   case per `FunctionComponentResult` shape: sync root, async root, `Child[]`,
   `null`, plus nested async children, `memo()`, `ErrorBoundary`, and a root
   that is itself a context provider. Each asserts a **primitive** `string`
   result, not just a matching value — the boxed-`String` wart is invisible to
   `toEqual`.

   The load-bearing case is **a raw string inside a `Child[]`**
   (`() => ['<script>alert(1)</script>', <p>ok</p>]`), asserted **escaped**.
   That is the exact input that made the rejected hand-written reduction a
   stored-XSS path, and it went unnoticed through three revisions because
   every earlier fixture put only `JSXNode`s in the array. Include the
   `Promise<string>`-in-array variant beside it.
2. **`ContentController.test.ts` — the response contract.** `view()` returns
   `text/html; charset=utf-8`, starts with `<!doctype html>`, honours
   `status`/`headers`/`doctype: false`, and **contains no
   `__INERTIA_PAGE__`**. This last assertion is the motivating bug expressed
   as a test.
3. **`plugin.test.ts` — provider binding.** `contentPlugin(config)` returns an
   independent provider class per call and binds `content.config`, mirroring
   `plugin-markdown/src/plugin.test.ts`.

A byte-size comparison (the same page through `inertia()` and through
`view()`) was considered as a fourth layer and rejected: it would need a full
Inertia app plus a realistic article fixture inside a plugin package, and the
ratio depends entirely on content size. The `__INERTIA_PAGE__` absence
assertion in layer 2 is the durable, machine-checkable form of the same
claim.

**Escaping tests belong here too** and should be treated as a security
suite, not a formatting one. Two groups, and the split is the point:

- **Asserted escaped**, because hono/jsx guarantees it: script tags as text
  children, and attribute breakout attempts (`" onmouseover="…`).
- **Asserted *not* escaped**, pinning the real boundary: a `javascript:`
  href passes through verbatim. A test that freezes this stops a future
  reader from assuming `view()` sanitizes URLs. The README must say scheme
  validation is the caller's job and point at
  `@guren/plugin-markdown`'s `http`/`https`/`mailto` allowlist.

`dangerouslySetInnerHTML` remains the documented opt-out, and the README must
say that content reaching it should have gone through
`@guren/plugin-markdown`'s sanitizer first.

**Error handling** needs one test and one decision the RFC currently ducks:
`view()` has no `try`/`catch`, so a component that throws or a rejected
render propagates to whatever `ExceptionHandler` catches at the router
boundary. That is probably correct — it matches how a throwing controller
action already behaves — but it should be asserted rather than assumed, and
it becomes a genuine design question for the `renderToReadableStream` follow-up,
where bytes already flushed cannot be retracted.

### Correspondence to `@guren/plugin-markdown`

| concern | plugin-markdown | plugin-content |
|---|---|---|
| primary API usable without `createApp` | `createMarkdownRenderer()` | `ContentController` subclassing |
| `definePlugin()` wrapper | `markdownPlugin()` | `contentPlugin()` |
| container binding | `'markdown'` (singleton) | `'content.config'` (instance) |
| deferred | no, deliberately | no, same reason |
| heavy optional dep | `shiki`, optional peer + subpath | `hono`, required peer, type-only |
| manifest `provider` | absent (factory) | absent (factory) |
| `compatibility` | `>=1.0.0 <2.0.0` | `>=1.0.0 <2.0.0` |

The two are complementary in practice: `plugin-markdown` produces the HTML
string, `plugin-content` puts it on the wire. The README should show them
composed, since that is the motivating application's actual pipeline.

### Release ordering

Nothing under `packages/create-app/templates/**` or
`packages/cli/templates/**` may reference `@guren/plugin-content` until the
release that publishes it has shipped — `smoke:starter:npm` is the gate that
would otherwise be correctly red. Same constraint RFC 0012 recorded.

## Alternatives Considered

- **Route it through `ViewEngine.register()`.** The first draft proposed
  this. Rejected on the published signature:
  `ViewRenderer = (template: string, props) => Response | Promise<Response>`
  takes a **string** template, and an `FC` is a function. Making this work
  means widening a type exported from `@guren/server`, which turns an
  additive plugin into a framework change with a changeset and an
  `audit:core-semver` obligation. `ViewEngine` also has exactly one
  registration in the repository and no `Controller` method that reads it, so
  it is a dormant seam rather than the intended extension point. The
  motivating app's decision to bypass it was correct.
- **Add `view()` to `Controller` in `@guren/server` directly.** Tempting, and
  it would let the framework own the doctype and escaping story. Rejected for
  v1: it puts a `hono/jsx` type dependency on every Guren app's `Controller`
  surface, and it is a public API addition to `@guren/server` requiring a
  changeset and — because `packages/core/src/index.ts` is
  `export * from '@guren/server'` — coordination with `@guren/core`'s
  independent 1.x line. Worth revisiting once the plugin has real usage;
  starting in a plugin keeps the blast radius at one new package, which is
  reversible.
- **Keep using `this.inertia()` for public pages.** Rejected on measured
  cost: 67% larger responses for content-heavy pages, plus the router-level
  Inertia SSR pipeline being bundled into every deploy target even when only
  the admin needs it (Cloudflare Workers deploys: 661 KB → 1,106 KB gzip in
  the motivating case, still within the free-tier 3 MB limit but a real cost
  with no corresponding benefit for those routes).
- **Keep hand-writing `renderPage(options, body): Response`.** What the
  motivating app actually did. Works, but every app rediscovers its own
  `escapeHtml()` and its own layout composition, with no shared hardening and
  a real XSS failure mode if one call site forgets to escape.
- **Take a JSX element instead of a component:** `view(<PostPage post={post} />)`.
  Simpler signature, but it forces every controller to become `.tsx` and to
  carry the `hono/jsx` pragma, and it loses the call-site prop inference that
  makes `view(Component, props)` type-check. Rejected.
- **Invoke the component directly and reduce the result by hand**, keeping
  `hono` a type-only import. Proposed by two earlier revisions of this RFC and
  **rejected on a security defect**: the hand-written reduction does not
  escape raw strings inside a `Child[]`, so a component returning
  `['<script>…', <p/>]` emits the script tag verbatim. Reimplementing hono's
  escaping, callback, and render-context semantics to get the coupling back
  is not a trade worth making in the one API whose promise is that it escapes
  by default. See "Stringifying a component tree".
- **A bespoke Blade/ERB-style template language** (`.guren` files, `@if`/
  `@foreach` directives, `@extends`/`@yield` layout inheritance, a compiler
  to JS). Rejected: it requires building and maintaining a parser, compiler,
  caching strategy, and editor tooling essentially from scratch, for a
  TypeScript audience that overwhelmingly already knows JSX. `hono/jsx` gives
  the same core value for the cost of wiring an existing dependency.

## Migration Path

Purely additive. No existing app is affected until it adds
`@guren/plugin-content` (and `hono`) to its dependencies and opts a
controller into `ContentController`. Apps that already hand-roll a
`renderPage()`-style function can migrate controller-by-controller; nothing
requires migrating all public routes at once, and `this.inertia()` remains
the right choice for any route that needs interactive or hydrated UI (the
motivating app keeps its `/admin/posts` editor on Inertia).

### Dogfooding target: guren.dev's blog, before any release

`web/` in this repository has the same defect, measured against production on
2026-08-22. Both `DocsController` and the blog's `BlogController` pass
rendered HTML as an Inertia prop (`doc`, `bodyHtml`), so it ships twice:

| `https://guren.dev/docs/guides/authentication` | raw | gzip |
|---|---|---|
| as shipped | 401,989 | 51,579 |
| with the `__INERTIA_PAGE__` blob removed | 253,541 | 34,221 |
| **saving** | **148,448 (36.9%)** | **17,358 (33.7%)** |

The gzip figure is the one that matters, and it does not collapse the way
duplicated content usually does: a third of the transferred bytes on a docs
page are the duplicate.

The two page types are not equally good targets, and the difference is the
useful part:

- **`resources/js/pages/blog/Show.tsx` is the best first migration, but it is
  not a drop-in.** 82 lines, no `useState`, no `useEffect`, no event handlers
  — it hydrates for nothing, which is the shape `view()` is for. The catch is
  `<Seo>`, which uses Inertia's `<Head>` to hoist a title, description,
  canonical link, RSS alternate, OpenGraph and Twitter tags, and JSON-LD into
  the document head from three levels down the tree.

  An earlier revision called that a blocker. Measurement says otherwise:
  hono/jsx hoists `<title>`, `<meta>`, and `<link>` natively, so all of
  `<Seo>` ports unchanged **except** its JSON-LD block, which must switch to
  `dangerouslySetInnerHTML` because hono escapes text children and would
  otherwise emit `{&quot;@type&quot;…}`. The page must also return a document
  with a `<head>` rather than the fragment it renders today, since hoisting
  needs somewhere to hoist to.

  Bounded work, and still the right first target.
- **`resources/js/pages/Docs/Show.tsx` is not a v1 target**, despite carrying
  the larger payload. It runs a scroll-spy table of contents, a mobile
  sidebar toggle, and Inertia `<Link>` SPA navigation. Migrating it means
  reimplementing those without a client framework, which is an islands
  problem this RFC does not solve. Recording it here so the payload number
  above is not mistaken for a migration plan.

Doing this inside `web/` is strictly better than waiting for the external
application, for a reason specific to this repository: `web/` resolves
`@guren/*` from the workspace, so it can adopt the plugin **before** the npm
release rather than after it. It also exercises the peer-dependency claim
directly — `web/` is one of the packages that cannot resolve `hono/jsx`
today, so it must add `hono` to its own dependencies exactly as the RFC tells
application authors to.

Revised order:

1. Implement the plugin; migrate `web/modules/blog`'s show page onto it
   inside this repository, workspace-resolved. This is the dogfooding gate.
2. Release.
3. Migrate the motivating external application, deleting its `renderPage()`
   and `escapeHtml()`.
4. Only then: reference the plugin from docs, guides, or any template.

## Open Questions

Questions 1 to 3 were opened in the first draft, and each now has a
conclusion grounded in the measurements above; they are recorded as
recommendations for the discussion period rather than as settled decisions.
Question 4 was **opened by review**, not answered — it is the one thing that
should block acceptance until it is settled.

### 1. Convention for distinguishing hydrating from non-hydrating JSX

**Conclusion: directory convention plus a documented arch rule. No new
`guren check` rule, and no lint dependency.**

The question assumed the distinction was invisible to tooling. It mostly is
not. Of the four ways the two runtimes can be confused, `tsc` already rejects
three (see the pragma table above): a missing pragma on an `FC`-annotated
component, a React component reaching `view()`, and an `FC`-annotated content
component imported into a React page. Adding a `guren check` rule for those
would duplicate the compiler.

**Two** shapes compile silently. An earlier revision claimed one; a review
pass found the second, so treat this enumeration as "the ones found so far"
rather than exhaustive:

1. A **pragma'd component with no `FC` annotation, imported into a React
   Inertia page**. It slips through because hono's `JSX.Element` is
   `HtmlEscapedString | Promise<HtmlEscapedString>` and `HtmlEscapedString`
   is a `String` subtype, which React accepts as a `ReactNode`. The
   consequence is a server-only component pulled into the client bundle.
2. A **React element placed as an expression child of a hono element**
   (`<div>{reactElement}</div>`). Intrinsic props are `Record<string, any>`,
   so nothing objects, and the child renders as **empty output** — content
   silently disappears. Note the neighbouring cases *are* caught: a React
   element assigned to a `Child`-typed binding is `TS2322`, and a React
   component used as a tag under the hono pragma is `TS2786`.

The directory rule below closes (1). It does **not** close (2), which is a
within-file mistake no boundary rule can see; only the missing-import error
a developer gets when the React component lives in a tree the content view
should not reach. This is a real, if narrow, residual risk and the RFC does
not claim otherwise.

Two cheap, existing mechanisms, and neither is new code:

- **The directory split is load-bearing for an independent reason.** Content
  views must live outside `resources/js/pages/` because
  `packages/cli/src/pages-types.ts` defaults `pagesDir` to exactly that path
  and would otherwise claim them as Inertia pages, with the Vite plugin
  watching them as such. `app/View/` is the proposal.
- **A documented `guren.arch.ts` rule** turns the residual gap into a
  `guren check --arch` failure, using the boundary vocabulary that already
  ships:

  ```typescript
  { from: 'resources/js/pages/**', disallow: 'app/View/**', includeTypeImports: true }
  ```

  `includeTypeImports` matters here: the leak is meaningful even as a type
  dependency, because it is one refactor from a runtime one.

The scaffold should additionally emit the explicit `: FC<Props>` annotation,
which is what makes the compiler catch the leak on its own. Astro's
`client:*` directives solve a different problem — Astro must decide *per
usage* what hydrates, whereas here nothing in `app/View/` ever hydrates.

### 2. Scope of v1

**Conclusion: `view()` only. Ship sitemap/RSS/robots as a follow-up, and
`renderToReadableStream` support as the most likely v1.1.**

The sitemap, RSS, robots, and canonical-URL helpers share no machinery with
`view()` — they are XML and header concerns, not component rendering — and
each carries its own design argument (absolute-URL derivation, caching,
`lastmod` sourcing from a model). Bundling them would put four unrelated
designs in one review.

The honest counter-argument, which the discussion period should weigh: if v1
is only `view()` plus a config binding, the package is roughly 80 lines, and
the "does this justify a package rather than a `@guren/server` subpath?"
question from the Alternatives section gets sharper. The case for the package
is reversibility — a plugin can be deprecated, a `Controller` method cannot —
and the fact that `contentPlugin`'s config binding is the natural home for
exactly the sitemap and canonical-URL helpers deferred here. If the discussion
concludes those helpers should land together, that argues for a larger v1 in
this same package, not for moving `view()` into the framework.

`hono/jsx/streaming`'s `renderToReadableStream` is the clearest v1.1: it
shares `view()`'s exact inputs and would add `viewStream()` alongside it.

### 3. Should `hono/jsx` become a re-export of `@guren/server`?

**Conclusion: no, and the question as posed would not have worked. Keep the
`hono/jsx` import in the plugin, and declare `hono` as a peer dependency.**

The question imagined re-exporting `hono/jsx` from `@guren/server` "the way
`@guren/core` re-exports ORM types from `@guren/orm`" — that is, adding names
to the barrel in `packages/server/src/index.ts`. Measured: that shape does
nothing for the actual need. A `jsxImportSource: "X"` pragma resolves
`X/jsx-runtime` and `X/jsx-dev-runtime`, never `X`, and a package without
those subpaths fails with `TS2875`. To make `jsxImportSource: "@guren/server"`
work, `@guren/server` would need two new `exports` subpaths whose only content
is `export * from 'hono/jsx/jsx-runtime'`.

That is a larger change than the question assumed, and it would be a bad
trade:

- It permanently couples `@guren/server`'s public export surface to hono's
  JSX runtime, in a package that already has to stay Node-safe and lean at
  the root.
- It buys app authors nothing they do not get from
  `jsxImportSource: "hono/jsx"` directly, since they must declare `hono`
  either way for the pragma to resolve.
- It removes nothing from the plugin, which needs the `FC` **type** from
  `hono/jsx` regardless.

The real problem the question was circling — that `hono` is not reliably
resolvable from app or plugin code — is solved by declaring it, not by
re-exporting it. The peer dependency in "Dependency shape" is that fix.

What may deserve a separate, narrow proposal later: re-exporting the `FC`
**type** (not the runtime) from `@guren/plugin-content` itself, so app authors
write `import type { FC } from '@guren/plugin-content'` and only the pragma
mentions hono. That keeps one name in app code pointing at the framework
while leaving the runtime coupling where it belongs.

### 4. What is `view()`'s document contract? (opened by review, unresolved)

**No conclusion. This is the question the discussion window exists for.**

**Scope note: this question is much smaller than two revisions ago.** It was
opened on the belief that head hoisting had no replacement. Measurement showed
hono/jsx hoists `<title>`, `<meta>`, and `<link>` natively, so what actually
remains is **locale** (small — `view()` can resolve `lang` from the request the
way `inertia()` does) and **assets** (the only part with real design weight,
because the existing manifest resolver is Inertia-specific).

Four candidate designs are described under "What `view()` deliberately does
not do": (a) document it as the Layout's job; (b) a typed `head` option;
(c) a `document` seam, incomplete as sketched; (d) bridge hono's
`jsxRenderer()`, prototyped and working, though it does not contribute
hoisting.

Two things make this concrete rather than theoretical:

- The RFC's nominated dogfooding target, `web/resources/js/pages/blog/Show.tsx`,
  turns out to be **mostly portable**: its `<Seo>` emits `<title>`, `<meta>`,
  and `<link>` tags, all of which hoist unchanged. Only its JSON-LD block
  needs rework, and only because hono escapes text children.
- The Problem section argues `view()` should exist so apps stop hand-writing
  `renderPage()`. If `view()` leaves the entire document to the app, it has
  moved the hand-written part rather than removed it — and the honest reply
  is that it still removes the dangerous part, escaping, which is a smaller
  claim than the current framing makes.

**Leaning: (a) plus `lang` resolution, with assets stated as an application
input for v1.** With hoisting native, a reference `Layout` is a short document
skeleton rather than a metadata framework, and (d) can be added later without
breaking `view()`'s signature — it is middleware, not a contract change.

The case a reviewer should make here is about assets: whether shipping v1
without a framework-supported way to inject the Vite stylesheet and import map
is acceptable, or whether a generic asset descriptor should be factored out of
`autoConfigureInertiaAssets` first.
