# RFC: Official Markdown-to-HTML Plugin (`@guren/plugin-markdown`)

**Author:** 7nohe
**Date:** 2026-08-20
**Status:** Accepted (2026-08-20 — accepted by the project maintainer under
author authority; the standard two-week discussion window was waived for this
solo-maintained change)

> Additive: a new plugin package, no changes to existing public APIs, and no
> changes to `@guren/server` on the critical path. The plugin wraps existing
> well-maintained libraries rather than shipping a new markdown engine.

## Problem

Rendering markdown to HTML is a staple need for Guren applications — blogs,
docs sites, CMS-backed pages, README viewers. The framework offers nothing for
it today, and the naive path is dangerous: render with any markdown library,
inject with `dangerouslySetInnerHTML`, and you have stored XSS, because
markdown syntax alone can carry `javascript:` URLs into `href`/`src` even when
raw HTML is escaped.

guren.dev has solved this twice, independently, in application code:

- **`web/app/Services/MarkdownRenderer.ts`** (docs pipeline): `marked` +
  `marked-highlight` + full `shiki`, GitHub-style alert directives
  (`[!NOTE]`…), heading ids with an XSS-hardened slugger, and relative-link
  rewriting. No sanitization — docs content is trusted repo content.
- **`web/modules/blog/app/Services/PostRenderer.ts`** (blog pipeline): the
  same engine, but with a fine-grained `shiki/core` bundle (explicit grammar
  list + `createJavaScriptRegexEngine`) so the Workers bundle does not pull
  every grammar plus the oniguruma WASM blob, and a `sanitize-html` allowlist
  tuned to pass shiki's inline styles and `--shiki-dark` custom properties
  while blocking script-bearing URLs and protocol-relative links.

Each of those files encodes decisions that took real review cycles to get
right (the sanitizer's style allowlist, the tag-splicing-resistant slugger,
the Workers bundle shape). Every Guren app that renders user- or CMS-supplied
markdown has to rediscover them, and the failure mode of not doing so is a
security bug, not a cosmetic one. This is the same "dogfood, then absorb"
shape that produced `make:auth`.

## Verified constraints (2026-08-20)

Measured against the npm registry and read out of the code rather than
assumed:

- **The candidate engines are all actively maintained.** Registry data,
  2026-08-20:

  | package | latest | published | downloads/week |
  |---|---|---|---|
  | `marked` | 18.0.10 | 2026-08-18 | 56.0M |
  | `markdown-it` | 15.0.0 | 2026-07-30 | 23.5M |
  | `micromark` (remark/rehype core) | 4.0.2 | 2025-02-27 | 46.1M |
  | `shiki` | 4.4.3 | 2026-08-10 | 17.4M |
  | `sanitize-html` | 2.17.7 | 2026-08-13 | 9.1M |

- **`marked` has zero runtime dependencies.** The unified (remark/rehype)
  equivalent of this feature set is dozens of transitive packages; for an
  official plugin that is supply-chain surface the framework signs up to
  audit.
- **First-party integration coverage differs by concern.**
  `marked-highlight` and `marked-gfm-heading-id` live in the `markedjs` org.
  The marked ecosystem's alert and shiki adapters (`marked-alert`,
  `marked-shiki`) are a single external maintainer's monorepo. On the unified
  side, `@shikijs/rehype` is released by the shiki team itself, in lockstep
  with shiki (4.4.3 on the same day).
- **Both existing guren.dev pipelines already sit on `marked`** (`^15`;
  latest is 18 — the plugin adopts current major, web/ upgrades when it
  migrates).
- **The in-house slugger is hardened beyond what the ecosystem plugin
  documents.** `MarkdownRenderer.ts` strips tags to a fixed point precisely
  because one pass can splice `<scr<x>ipt>` into `<script>`, and avoids the
  quadratic `/<[^>]*>/g` scan. `marked-gfm-heading-id` delegates to
  `github-slugger` with no equivalent published analysis; adopting it would
  need that verification first.
- **The plugin contract is already defined.** `contributing/plugin-contract.md`:
  official naming `@guren/plugin-{name}`, a `definePlugin()` factory as the
  primary export, and a `gurenPlugin` manifest whose `compatibility` field is
  mandatory for first-party plugins (`audit:plugin-compat` enforces it, and
  `guren plugin` refuses to load on mismatch).
- **New packages need no build wiring.** `scripts/build-packages.ts` and
  `test:bun` discover workspace packages automatically.
- **Release ordering is a known trap.** Nothing under
  `packages/create-app/templates/**` or `packages/cli/templates/**` may
  reference the plugin until the release that publishes it ships
  (`.claude/rules/common-pitfalls.md`, "Templates vs. Published Packages").

## Proposed Solution

A new workspace package `packages/plugin-markdown`, published as
`@guren/plugin-markdown`. It is a thin, opinionated assembly over `marked`
(+ `marked-highlight`) and `sanitize-html`, with `shiki` as an optional peer
dependency behind a subpath export. The value it adds over "install marked
yourself" is exactly the hardened defaults the two guren.dev pipelines
converged on.

### Core API: a plain factory, usable without the plugin machinery

```typescript
import { createMarkdownRenderer } from '@guren/plugin-markdown'

const renderer = createMarkdownRenderer({
  // All defaults shown.
  gfm: true,
  // Sanitize the rendered HTML with the shiki-compatible allowlist.
  // `false` is the explicit opt-out for trusted content (own docs).
  sanitize: true,
  // GitHub-style `> [!NOTE]` blockquote alerts.
  alerts: true,
  // Heading ids via the hardened slugger (tag-splice resistant, unique per render).
  anchors: true,
  // Optional hooks:
  rewriteLink: undefined as ((href: string) => string) | undefined,
  highlight: undefined as ((code: string, lang?: string) => Promise<string>) | undefined,
})

const html: string = await renderer.render(markdown)
```

Design points:

- **`render()` is a pure async function of its input.** Per-render state (the
  heading slug uniqueness map) is created inside `render()`, exactly as
  `MarkdownRenderer.ts` does with its per-request `Marked` instance, so one
  renderer instance is safe under concurrent requests. Whether the app calls
  it at save time (the blog pattern) or at request time (the docs pattern) is
  the app's choice; the plugin has no opinion and no cache.
- **`sanitize: true` is the default** — secure by default, matching the
  repo's stated posture. The default allowlist is the one shipped in
  `PostRenderer.ts`: structural tags only, `href`/`src` restricted to
  `http`/`https`/`mailto`, `allowProtocolRelative: false`, and a style
  allowlist admitting only the declarations shiki emits (colors,
  `--shiki-dark`/`--shiki-dark-bg`, font style/weight, text-decoration).
  Escaped rather than stripped (`disallowedTagsMode: 'escape'`), so rejected
  markup stays visible instead of vanishing.
  Extension without replacement:

  ```typescript
  sanitize: (defaults) => ({
    ...defaults,
    allowedTags: [...defaults.allowedTags, 'video'],
  })
  ```

  The callback receives and returns `sanitize-html`'s options type. This
  couples the public API to `sanitize-html`'s types deliberately — inventing
  a parallel schema type would be a maintenance liability with no security
  gain.
- **`highlight` is just a function** `(code, lang) => Promise<string>` wired
  through `marked-highlight`. The root export has no dependency on shiki.
- **Alerts and the slugger are ported in-house code, not new dependencies.**
  Both are small (~60 lines each), already written, and already hardened in
  `web/`. Porting them avoids adding single-maintainer packages
  (`marked-alert`) or an unverified slugger (`marked-gfm-heading-id`) to the
  framework's dependency set. Alert markup uses framework-neutral class names
  (`guren-markdown-alert guren-markdown-alert--note`, label + body structure
  as in `MarkdownRenderer.ts`); the package ships an optional reference
  stylesheet but applies no styling itself.

### Shiki integration: a subpath, so the root stays dependency-light

```typescript
import { createShikiHighlight } from '@guren/plugin-markdown/shiki'

const highlight = createShikiHighlight({
  themes: { light: 'rose-pine-dawn', dark: 'rose-pine-moon' },
  // Explicit grammar list — the Workers-safe fine-grained bundle is the
  // default shape, not the opt-in.
  langs: ['typescript', 'tsx', 'bash', 'json'],
})

const renderer = createMarkdownRenderer({ highlight })
```

`createShikiHighlight` builds a `shiki/core` highlighter with
`createJavaScriptRegexEngine()` and the requested grammars/themes, lazily and
once (the `PostRenderer.ts` pattern). **Amended in implementation:** the
factory is synchronous and returns the highlight function immediately (the
highlighter loads on first use), and grammar names resolve via runtime
dynamic import — bundle-static targets (Workers) pass explicit
`langModules`/`themeModules` imports instead of names. It renders dual-theme output
(`defaultColor: 'light'`, dark palette in `--shiki-dark` custom properties)
so the sanitizer default and the highlighter agree with each other out of the
box. Unknown or unloaded languages fall back to plain text rather than
throwing.

`shiki` is declared as an **optional peer dependency** (`>=3 <5` — both the
`^3.15` guren.dev uses today and current v4 satisfy the API used). Apps that
never import the `/shiki` subpath never install it. The subpath import fails
with a clear "install shiki" error when the peer is absent.

### Plugin form: a thin `definePlugin()` over the factory

```typescript
import { markdownPlugin } from '@guren/plugin-markdown'

createApp({
  providers: [
    markdownPlugin({
      /* same options as createMarkdownRenderer */
    }),
  ],
})
```

The provider registers the configured renderer as a ~~deferred~~ container
singleton:

```typescript
const factory = definePlugin<MarkdownPluginConfig>({
  name: 'markdown',
  register(container, config) {
    container.singleton('markdown', () => createMarkdownRenderer(config))
  },
})
```

**Amended in implementation:** the provider is not deferred. A deferred
service cannot be resolved with a plain synchronous `container.make()` until
its loader has been awaited (`ProviderManager.loadDeferredProvider`), and
constructing the renderer is trivial — the expensive work happens per render
— so deferral bought nothing and broke the obvious resolution path.

Controllers resolve it with `this.container.make<MarkdownRenderer>('markdown')`.
The plugin form exists for the `guren plugin @guren/plugin-markdown` install
UX, container-mediated configuration, and as the future home of related
scaffolding (e.g. a blog-shaped `make:*`); the factory stays the primary API
and works without `createApp` at all.

### Package manifest

Mirrors `@guren/plugin-cloudflare`:

```json
{
  "name": "@guren/plugin-markdown",
  "gurenPlugin": {
    "compatibility": ">=1.0.0 <2.0.0"
  },
  "dependencies": {
    "@guren/core": "^1.7.0",
    "marked": "^18.0.10",
    "marked-highlight": "^2.2.4",
    "sanitize-html": "^2.17.7"
  },
  "peerDependencies": { "shiki": ">=3.0.0 <5.0.0" },
  "peerDependenciesMeta": { "shiki": { "optional": true } }
}
```

`compatibility` matches the current `@guren/core` 1.x line, same as the deploy
plugins; `audit:plugin-compat` keeps it honest across future releases. No
`commands` entry initially — the plugin ships no CLI commands.

### Testing

- **Known-answer rendering tests** freeze the wrapped libraries' observable
  behavior (fixture markdown → exact HTML), so a `marked`/`sanitize-html`
  upgrade that changes output fails loudly instead of silently — the policy
  adopted after the aws4fetch review.
- **XSS regression suite** ported from `web/`: `javascript:`/`data:`/
  protocol-relative URLs in links and images, raw-HTML escape, the
  `<scr<x>ipt>` tag-splice slug case, style-allowlist boundaries.
- **Shiki subpath tests** cover dual-theme output surviving the default
  sanitizer, and unknown-language fallback.
- The core suite must pass with shiki absent (optional peer), the subpath
  suite with it present.

## Alternatives Considered

- **Build on unified (remark/rehype) instead of marked.** Strongest
  competitor: sanitization happens on the AST before serialization
  (`rehype-sanitize`), and the shiki team ships `@shikijs/rehype` first-party.
  Rejected for now on dependency surface (dozens of transitive packages vs.
  marked's zero), render cost on the request path, and continuity — both
  existing production pipelines are marked-based, so migrating guren.dev onto
  the plugin (the dogfooding step) is a diff, not a rewrite. If the plugin
  later grows AST-level extension points, this decision should be revisited
  rather than emulated on top of marked.
- **Build on markdown-it.** Actively maintained (15.0.0, 2026-07) with a
  first-party shiki adapter, but its render core is synchronous (async
  highlighting requires pre-loading grammars around it), the plugin ecosystem
  is of uneven quality, and it has no continuity advantage here.
- **Use ecosystem plugins for alerts and heading ids** (`marked-alert`,
  `marked-gfm-heading-id`). Rejected: the first adds a single-maintainer
  dependency for ~60 lines the repo already owns; the second replaces a
  slugger with published hardening analysis by one without.
- **A library package (`@guren/markdown`) with no plugin form.** The renderer
  genuinely needs no ServiceProvider. Rejected because the plugin form is
  cheap (a `definePlugin` wrapper), buys the `guren plugin` install flow and
  a home for future scaffolding, and the factory-first design keeps the
  library use case first-class anyway.
- **Ship it inside `@guren/server` as a subpath.** Rejected: markdown
  rendering is not universal, and the dependencies (`sanitize-html`,
  optionally `shiki`) would land in every app's tree. Opt-in surface belongs
  in a plugin — same reasoning as the deploy plugins.
- **Sanitize with DOMPurify instead of sanitize-html.** DOMPurify is heavier
  to run server-side (needs a DOM; jsdom on Bun, or isomorphic wrappers), and
  the existing tuned allowlist is already expressed in `sanitize-html`'s
  vocabulary. No security argument favored switching.

## Migration Path

Purely additive; nothing breaks and no user action is required.

Post-release, in order:

1. Migrate `web/modules/blog/app/Services/PostRenderer.ts` onto the plugin
   (workspace-resolved), deleting the local sanitizer config — this is the
   dogfooding gate before recommending it publicly.
2. Migrate `web/app/Services/MarkdownRenderer.ts` (docs pipeline:
   `sanitize: false`, `rewriteLink` hook carries the existing
   `rewriteDocLink`).
3. Only after the npm release ships: reference the plugin from docs, guides,
   and any template or scaffold (`smoke:starter:npm` is the gate that would
   otherwise be red — common-pitfalls, "Templates vs. Published Packages").

## Open Questions

- **Should the CLI's official zero-config table include `markdownPlugin()`?**
  The table exists for plugins installable before `bun add` completes
  (`plugin-contract.md`). `markdownPlugin()` is zero-config-safe (all options
  have defaults), so it qualifies technically; whether auto-registering a
  renderer nobody resolves is worth it is a judgment call.
- **Reference stylesheet delivery.** Alerts and dual-theme shiki output need
  CSS to look right. Ship as a plain `.css` file consumers import via Vite
  (`@guren/plugin-markdown/styles.css`), or document-only? Proposal: ship the
  file, keep it out of the default path.
- **Version pin discipline for `marked`.** Caret range (as drafted) or exact
  pin with known-answer tests as the tripwire? The drizzle precedent argues
  exact pins matter when two copies can meet in one process; nothing consumes
  marked's types across package boundaries here, so caret + frozen fixtures
  looks sufficient.
- **i18n of alert labels.** `Note`/`Warning`… are English in the ported
  implementation. Accept a `labels` option now, or wait for demand?
