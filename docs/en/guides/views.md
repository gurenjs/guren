# Server-Rendered Views

`this.view()` renders a JSX component to a plain server-rendered HTML response — the non-hydrating counterpart to `this.inertia()` for public, read-mostly pages: blog posts, docs, marketing pages. No client framework, no hydration, no Inertia page-payload script in the document. It is what guren.dev uses for its own blog posts.

```ts
// app/Http/Controllers/BlogController.ts — plain .ts, zero JSX syntax
import { Controller } from '@guren/core'
import { z } from 'zod'
import { ShowPage, PostNotFoundPage } from '../../View/ShowPage.js'
import { Post } from '../../Models/Post.js'

const SlugParamSchema = z.object({ slug: z.string().min(1) })

export default class BlogController extends Controller {
  async show() {
    const { slug } = this.validateParams(SlugParamSchema)
    const post = await Post.where({ slug }).first()

    if (!post) {
      return this.view(PostNotFoundPage, {}, { status: 404 })
    }

    return this.view(ShowPage, { post })
  }
}
```

`view(component, props, options?)` takes a component and its props — not a JSX element — so controllers stay plain `.ts` files. Props are compile-checked at the call site: a wrong prop name is a type error immediately, with no codegen step in between. The optional third argument accepts `status` and `headers` plus a `doctype` flag ([see below](#full-documents-and-fragments)).

## When to use `view()` vs `this.inertia()`

`this.inertia()` is the right choice for interactive, stateful UI — forms, dashboards, anything that navigates client-side. But on an initial document request, Inertia embeds the full page props as a JSON script in `<head>`, and when server-side rendering is enabled the same content is *additionally* rendered as HTML in `<body>`. A large prop — an article body, most obviously — ships twice.

Measured while migrating a real blog off Inertia for its public pages: the same article weighed 443 KB as an Inertia SSR document and 144 KB as plain server-rendered HTML. On guren.dev, the duplicated payload survived compression well enough to be 33.7% of the gzipped response on a docs page.

| Use `this.inertia()` | Use `this.view()` |
|---|---|
| Interactive UI: forms, dashboards, admin panels | Public, read-mostly content: blog posts, docs, marketing pages |
| Client-side navigation between pages | Fresh navigations and crawlers — SEO-critical pages |
| State that lives in React | Pages that hydrate nothing worth a framework |

The two coexist in one app: guren.dev's blog serves its post page with `view()` while the admin editor stays on Inertia.

## Your first View component

View components live in `app/View/*.tsx` (module-local: `modules/<name>/app/View/`), never under `resources/js/pages/` — codegen claims that directory for Inertia pages. Every View file starts with a JSX pragma pointing at `@guren/core` and imports its types from there — your app never declares `hono` as a dependency; the JSX runtime is re-exported through `@guren/core`, which the app already has:

```tsx
// app/View/Layout.tsx — the document skeleton every page wraps itself in
/** @jsxImportSource @guren/core */
import { viteAsset, type FC, type PropsWithChildren } from '@guren/core'

export const Layout: FC<PropsWithChildren<{ head?: unknown }>> = ({ head, children }) => (
  <html lang="en">
    <head>
      <meta charSet="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <link rel="stylesheet" href={viteAsset('resources/css/app.css')} />
      {head as never}
    </head>
    <body>{children as never}</body>
  </html>
)
```

```tsx
// app/View/ShowPage.tsx — server-only, never hydrates
/** @jsxImportSource @guren/core */
import type { FC } from '@guren/core'
import { Layout } from './Layout.js'

type PostView = { slug: string; title: string; description: string; bodyHtml: string }

export const ShowPage: FC<{ post: PostView }> = ({ post }) => (
  <Layout
    head={
      <>
        <title>{post.title} | example.com</title>
        <meta name="description" content={post.description} />
        <link rel="canonical" href={`https://example.com/blog/${post.slug}`} />
      </>
    }
  >
    <article dangerouslySetInnerHTML={{ __html: post.bodyHtml }} />
  </Layout>
)
```

Text children and attribute values are HTML-escaped automatically — `{post.title}` is safe whatever the title contains. The `bodyHtml` injection is safe here because it comes out of a sanitizing renderer; see [the security boundary](#the-security-boundary) for where that responsibility sits.

## The Layout pattern

A Layout is a plain component with an `<html>` root that each page wraps itself in — there is no layout registry or middleware. Two rules keep documents correct and fast:

**The Layout's own `<head>` carries only what pages never restate** — charset, viewport, the stylesheet link, site-wide tags like an RSS discovery link. Per-page metadata (`<title>`, descriptions, canonical URLs) belongs to the page component. This is not just tidiness: metadata rendered by pages is *appended* to `<head>`, never replaced — deduplication skips the Layout's literal children, and browsers use the **first** `<title>` they see. A hard-coded default `<title>` in the Layout silently shadows every page's title.

**Pass page metadata through a Layout `head` slot, not the body.** Tags rendered anywhere in the tree — `<title>`, `<meta>`, `<link>` — are hoisted into `<head>` natively, so a deeply nested component can still contribute metadata. But hoisting rescans the document per hoisted tag, which is quadratic in tag count: a 15-tag SEO block rendered in the body costs about a millisecond per render and grows with page size. The `head` slot in the Layout above renders the same tags directly into `<head>` at flat cost. Hoisting stays as the safety net for tags emitted deep in the tree; the slot is the fast path.

`<script type="application/ld+json">` and `<style>` are *not* hoisted — they render where you put them.

## Resolving assets: `viteAsset()`

A content page needs its stylesheet URL, and that URL is environment-dependent. `viteAsset(entry)` owns both branches:

- **Development** — the Vite dev server serves the source path directly, so `viteAsset('resources/css/app.css')` returns the dev-server URL for that path.
- **Production** — the entry is looked up in the Vite build manifest and the hashed output file is returned, served with immutable caching.

If neither resolves, `viteAsset()` throws an error naming the paths it tried — never a silent empty string.

One requirement to know about: **a CSS file bundled through a JS entry has no manifest key of its own.** Declare the stylesheet as an explicit build input so Vite emits and records it:

```ts
// vite.config.ts
export default defineConfig({
  build: {
    rollupOptions: {
      input: ['resources/js/app.tsx', 'resources/css/app.css'],
    },
  },
  // ...
})
```

### Serverless targets

Serverless bundles ship without the build output directory, so there is no manifest file to read at runtime. The deploy plugins (`@guren/plugin-cloudflare`, `@guren/plugin-vercel`, `@guren/plugin-lambda`) handle this during their build step by injecting the manifest JSON into the `GUREN_VITE_MANIFEST` environment variable; `viteAsset()` prefers it over the filesystem. No configuration on your side — `view()` pages work on targets whose runtime never sees `public/assets/manifest.json`.

## Full documents and fragments

Forgetting to wrap a page in its Layout would fail *softly*: the page still renders a 200, but with no `<head>` to hoist into, every `<title>` and `<meta>` stays inline in the body and no stylesheet is linked. You would notice the missing styles in development; a crawler reading SEO tags out of `<body>` is noticed much later.

So `view()` fails loudly instead: a component that renders a fragment rather than an `<html>`-rooted document throws a descriptive error at first render. When a fragment is what you want — an HTML partial for a widget, say — pass `{ doctype: false }`:

```ts
return this.view(CommentPartial, { comment }, { doctype: false })
```

This skips both the document check and the `<!doctype html>` prefix.

## The security boundary

Automatic escaping prevents markup and attribute breakout: a `<script>` tag in a text child renders as text, and a `"` in an attribute value cannot terminate the attribute. Two things remain your responsibility:

**URL schemes are not validated.** `href={userProvidedUrl}` passes a `javascript:` URL through verbatim — escaping is about HTML structure, not link targets. For user-supplied content, sanitize upstream: [`@guren/plugin-markdown`](./markdown.md)'s sanitizer restricts `href`/`src` to `http`, `https`, and `mailto`, and its output is safe to inject with `dangerouslySetInnerHTML`. Rendering sanitized markdown into a View component is exactly the guren.dev blog pipeline.

**JSON-LD needs `dangerouslySetInnerHTML`.** Text children are HTML-escaped, which turns inline JSON into garbage. Emit structured data with the `<` characters escaped as `\u003c` (valid JSON, and inert inside a script element):

```tsx
<script
  type="application/ld+json"
  dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</g, '\\u003c') }}
/>
```

## Keeping the two JSX worlds apart

An app using both `view()` and Inertia contains two JSX dialects: React under `resources/js/pages/` (hydrates in the browser) and server-only components under `app/View/`. The compiler already rejects most confusions — a React component passed to `view()`, a View component rendered inside a React page, a missing pragma on an annotated component. Always annotate View components explicitly as `FC<Props>`; an unannotated component is one of the shapes the compiler cannot catch crossing the boundary.

For the rest, add a boundary rule to `guren.arch.ts` and `bunx guren check` enforces it:

```ts
// guren.arch.ts
import { defineArchRules } from '@guren/cli/arch'

export default defineArchRules({
  rules: [
    // Inertia pages must not import server-only View components.
    { from: 'resources/js/pages/**', disallow: ['app/View/**', 'modules/*/app/View/**'], includeTypeImports: true },
  ],
})
```

See the [CLI guide](./cli.md) for how architecture rules work in general.

## Gotchas

Lessons from migrating guren.dev's blog, worth knowing before your first page:

- **Inertia `<Link>` to a `view()` route breaks.** The route returns plain HTML, which the Inertia client rejects with its error dialog. Link into `view()` routes with a plain `<a href>` — from Inertia pages too.
- **Format dates with an explicit `timeZone`.** Date formatting that moves server-side renders in the *server's* time zone — a server in Los Angeles renders "June 30" for a July 1 UTC instant. Pin it: `new Intl.DateTimeFormat('en-US', { dateStyle: 'long', timeZone: 'UTC' })`.
- **Tailwind must scan `app/View/`.** Tailwind v4's automatic source detection already covers it. On v3-style `content` globs, add `./app/View/**/*.tsx` (and `./modules/*/app/View/**/*.tsx` if you use modules) or your View components' classes are purged from the build.
- **No HMR.** `view()` pages carry no Vite client, so there is nothing to hot-reload — edit and refresh. That is the deal: zero client JavaScript unless you add some.

## Testing

A `view()` response is plain HTML — assert on the document text:

```ts
const response = await controller.show()
const html = await response.text()

expect(response.status).toBe(404)
expect(html).toContain('Post not found')
expect(html).toMatch(/<link rel="stylesheet"/)
```

For isolated controller tests under Vitest, `createControllerModuleMock()` from `@guren/testing` supports `view()` and exports a `viteAsset()` mock (requires `@guren/testing` 1.7.0 or later). Both delegate to the real rendering engine — escaping, the fragment guard, and asset resolution behave exactly as in production, and `viteAsset()` returns deterministic dev-server URLs under test. See the [Testing guide](./testing.md) for the controller-testing helpers in general.

## Next steps

- [Controllers](./controllers.md) — the rest of the response helpers, validation, and route model binding
- [Frontend](./frontend.md) — the Inertia side: pages, layouts, and type-safe props
- [Markdown Rendering](./markdown.md) — the sanitizing markdown pipeline that pairs with `view()` for content sites
