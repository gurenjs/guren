# RFC: Non-Inertia Content Rendering Plugin (`@guren/plugin-content`)

**Author:** 7nohe
**Date:** 2026-08-22
**Status:** Draft

> Additive: a new plugin package plus a `ContentController` base class it
> exports. No changes to `@guren/core`, `@guren/server`, or any existing
> public API — `Controller.view()` lives on the plugin's own subclass, not on
> the framework's `Controller`.

## Problem

Guren ships one first-class way to render a page response: `this.inertia(page,
props)`. That is the right choice for interactive, stateful UI — but it has a
measured cost for public, read-mostly content pages (blog posts, docs,
marketing pages) that don't need client-side hydration at all.

`InertiaEngine` always emits `<script>window.__INERTIA_PAGE__ = {...}</script>`
in `<head>`, whether or not SSR is enabled. When SSR is enabled, the same
content is *also* rendered into `<body>` as HTML — so a large prop (an
article body, most obviously) ships twice: once as escaped JSON, once as
HTML. Measured while migrating a real Guren app (a blog: 21 posts, Shiki
syntax highlighting) off Inertia for its public pages:

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

**The framework already has the right extension point, but no ergonomic way
to reach it from a controller.** `ViewEngine.register(name, renderer)` lets
an app register a renderer that returns a `Response` — but `Controller` has
no `this.view(...)` (or equivalent) method that calls into it, the way
`this.inertia(...)` calls into the Inertia renderer. In practice this pushed
the migrated app to skip `ViewEngine` entirely and hand-write a
`renderPage(options, body): Response` free function that string-concatenates
HTML, with a hand-rolled `escapeHtml()` the author has to remember to call at
every interpolation site. That is the same "dogfood, then absorb" gap
`@guren/plugin-markdown` (RFC 0012) closed for markdown rendering — every app
that wants public content pages has to rediscover the same shape, and here
the failure mode of forgetting `escapeHtml()` is a stored-XSS bug, not a
cosmetic one.

## Proposed Solution

A new package `packages/plugin-content`, published as
`@guren/plugin-content`. It does two things:

1. Wires a JSX-based renderer into `ViewEngine` via `definePlugin()`.
2. Exports a `ContentController` base class with a `view()` method that
   gives controllers an Inertia-shaped ergonomic for it.

It reuses `hono/jsx` — already a transitive dependency of every Guren app
through `@guren/server` → `hono`, but not currently exposed by any Guren
package — rather than inventing a template DSL (Blade/ERB-style
`.blade.php`/`.erb` compilation). `hono/jsx` gives auto-escaping-by-default
interpolation, composable layout/partial components, and syntax every Guren
app author already knows from writing Inertia pages, for the cost of wiring
up an existing dependency instead of building and maintaining a parser,
compiler, and editor tooling for a new language.

### Core API

```typescript
// packages/plugin-content/src/index.ts
export { contentPlugin } from './plugin.js'
export { ContentController } from './ContentController.js'
```

```typescript
// packages/plugin-content/src/plugin.ts
import { definePlugin } from '@guren/core'
import { ViewEngine } from '@guren/server'

export interface ContentPluginConfig {
  siteName: string
  siteUrl: () => string
}

export const contentPlugin = definePlugin<ContentPluginConfig>({
  name: 'content',
  register(container, config) {
    container.instance('content.config', config)
  },
})
```

```typescript
// packages/plugin-content/src/ContentController.ts — plain .ts, no JSX syntax
import { Controller } from '@guren/core'
import { createElement, type FC, type Props } from 'hono/jsx'

export abstract class ContentController extends Controller {
  protected async view<P>(component: FC<P>, props: P): Promise<Response> {
    const element = createElement(component, props as Props)
    // JSXNode#toString() returns `string | Promise<string>` — hono/jsx
    // supports async components, so this must await either shape.
    const html = await element.toString()
    return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } })
  }
}
```

### Usage

```tsx
// app/View/PostPage.tsx — the only file in the app that needs JSX syntax
/** @jsxImportSource hono/jsx */
import type { FC } from 'hono/jsx'
import type { PostRecord } from '../Models/Post.js'
import { Layout } from './Layout.js'

export const PostPage: FC<{ post: PostRecord }> = ({ post }) => (
  <Layout title={`${post.title} | 7nohe.dev`}>
    <article dangerouslySetInnerHTML={{ __html: post.contentHtml as string }} />
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

### Why this keeps end-to-end type safety without codegen

`view<P>(component: FC<P>, props: P)` infers `P` from the real, imported
function type of `component` — ordinary TypeScript generic inference, the
same mechanism as any other typed callback parameter. Changing `PostPage`'s
prop shape breaks every `this.view(PostPage, ...)` call site immediately at
`tsc` time, with IDE rename-refactor following through to the controller.

This is a stronger guarantee than the Inertia page-prop story, which needs
`bunx guren codegen` to read each page's `interface Props` and (re)generate
`PagePropsMap` before `this.inertia(pages.posts.Show, props)` type-checks
against it — forgetting to re-run codegen after changing a page's props is a
known staleness window (`.claude/rules/controllers-http.md`: "If props don't
type-check, re-run codegen"). Because `PostPage` here is a plain imported
value, not a codegen-resolved string key, there is no generation step and no
window where the types can go stale. `guren check`'s route ↔ controller ↔
page consistency check has nothing new to verify for this path — the
compiler already enforces it.

`createElement`'s own declared signature (`(tag, props: Props | null, ...)`
where `Props = Record<string, any>`) is intentionally loose — hono/jsx's
runtime doesn't type-check props at that layer. The safety boundary is
`ContentController.view()`'s public generic signature, not the internal
`createElement` call; the `props as Props` cast inside `view()` is sound
because the shape was already checked against `FC<P>` at the call site.

### JSX import source

Project `tsconfig.json`s created by `create-app` set `"jsx": "react-jsx"`
with no explicit `jsxImportSource` (implicitly `react`), because Inertia
pages under `resources/js/pages/` need React's JSX runtime. A file using
`hono/jsx` in the same project needs the per-file pragma:

```tsx
/** @jsxImportSource hono/jsx */
```

Both `tsc` and Bun's transpiler honor this per-file override, so no second
`tsconfig.json` or separate build target is needed. A future
`bunx guren make:content-page` scaffold (out of scope for this RFC) would
emit this pragma automatically so app authors don't need to know about it.

## Alternatives Considered

- **Keep using `this.inertia()` for public pages.** Rejected on measured
  cost: 67% larger responses for content-heavy pages, plus the router-level
  Inertia SSR pipeline being bundled into every deploy target even when only
  the admin actually needs it (Cloudflare Workers deploys: 661 KB → 1,106 KB
  gzip in the case that motivated this RFC, still within the free-tier 3 MB
  limit but a real cost with no corresponding benefit for those routes).
- **Keep hand-writing `renderPage(options, body): Response` as a free
  function, string-concatenated HTML.** What the motivating app actually did.
  Works, but every app rediscovers its own `escapeHtml()` and its own
  ad-hoc layout composition, with no shared hardening and a real XSS failure
  mode if a call site forgets to escape.
  `ViewEngine.register()` already exists to prevent exactly this kind of
  divergence but has no ergonomic entry point from `Controller`, so nothing
  routes through it in practice.
- **A bespoke Blade/ERB-style template language** (`.guren` files, `@if`/
  `@foreach` directives, `@extends`/`@yield` layout inheritance, a compiler
  to JS). Rejected: this requires building and maintaining a parser,
  compiler, caching strategy, and editor tooling (syntax highlighting, LSP)
  essentially from scratch, for a TypeScript audience that overwhelmingly
  already knows JSX. `hono/jsx` gives the same core value (safe-by-default
  interpolation, composable layout/partials, familiar control flow via plain
  JS/TS) for the cost of wiring up a dependency Guren apps already ship.

## Migration Path

Purely additive — no existing app is affected until it adds
`@guren/plugin-content` as a dependency and opts a controller into
`ContentController`. Apps that already hand-roll a `renderPage()`-style
function (as the motivating app does) can migrate controller-by-controller;
nothing requires migrating all public routes at once, and `this.inertia()`
remains the right choice for any route that needs interactive/hydrated UI
(this RFC's own example app keeps its `/admin/posts` editor on Inertia).

## Open Questions

- **Directory/naming convention to avoid confusing hydrating vs. non-hydrating
  JSX.** `resources/js/pages/*.tsx` (Inertia, hydrates) and, say,
  `app/View/*.tsx` (`ContentController`, server-only, never hydrates) look
  identical at a glance — both are `.tsx` files with components. Astro solves
  the equivalent ambiguity with explicit `client:*` directives on otherwise
  static components. Does this RFC need a lint rule / `guren check` warning
  if a `ContentController` view file is ever imported from
  `resources/js/pages/`, or is directory convention + documentation enough
  for a v1?
- **Scope of v1.** Should `@guren/plugin-content` also ship the
  sitemap/RSS/robots response helpers and canonical-URL/`www` redirect logic
  the motivating app hand-wrote in its `MetaController`, or is that a
  follow-up RFC once more than one app has adopted the core `view()`
  primitive and the shared shape is clearer?
- **Should `hono/jsx` become a direct, first-class re-export of
  `@guren/server`** (the way `@guren/core` already re-exports ORM types from
  `@guren/orm`) rather than a `hono/jsx` import inside a plugin package? Doing
  so now would be speculative before any app has used this pattern; deferring
  it keeps this RFC's blast radius to a single new package.
