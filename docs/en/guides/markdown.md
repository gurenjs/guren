# Markdown Rendering

`@guren/plugin-markdown` renders markdown to HTML with hardened defaults: GitHub Flavored Markdown, sanitized output safe for `dangerouslySetInnerHTML`, GitHub-style alerts, heading anchors, and optional shiki code highlighting. It is the pipeline guren.dev itself uses for its docs and blog.

## Install

```bash
bunx guren plugin @guren/plugin-markdown
bun add @guren/plugin-markdown
```

## Rendering

```ts
import { createMarkdownRenderer } from '@guren/plugin-markdown'

const renderer = createMarkdownRenderer()
const html = await renderer.render('# Hello\n\n> [!NOTE]\n> Sanitized by default.')
```

`render()` is a pure async function of its input: one renderer instance is safe under concurrent requests, and the package keeps no cache. Render at save time and store the HTML (the blog pattern), or render per request — that choice belongs to your app.

All options with their defaults:

```ts
createMarkdownRenderer({
  gfm: true,        // tables, strikethrough, autolinks
  sanitize: true,   // allowlist-sanitize the output (see below)
  alerts: true,     // GitHub-style > [!NOTE] blockquote alerts
  anchors: true,    // heading id attributes
  rewriteLink: undefined,   // (href: string) => string
  highlight: undefined,     // code-fence highlighter (see below)
})
```

## Sanitization

Markdown syntax alone can carry `javascript:` and `data:` URLs into `href` and `src`, so escaping raw HTML is not enough on its own. With the default `sanitize: true`, the rendered HTML passes a `sanitize-html` allowlist before it is returned:

- structural tags only; raw HTML like `<script>` is escaped, not silently dropped
- `href`/`src` restricted to `http`, `https`, and `mailto`; protocol-relative URLs (`//host/path`) are rejected
- inline styles limited to the declarations shiki emits (colors and the `--shiki-dark` custom properties), so highlighted code survives sanitization intact
- heading `id`s and the alert markup are admitted by exact value

The result is safe to inject with `dangerouslySetInnerHTML`.

Extend the allowlist without replacing it by passing a callback — it receives the defaults and returns the options to use:

```ts
createMarkdownRenderer({
  sanitize: (defaults) => ({
    ...defaults,
    allowedTags: [...(defaults.allowedTags as string[]), 'video'],
  }),
})
```

For trusted content — your own docs rendered at build time — opt out explicitly with `sanitize: false`.

## Alerts

GitHub's five blockquote directives render as labeled alert blocks:

```markdown
> [!NOTE]
> Something worth knowing.

> [!WARNING]
> Something worth checking.
```

The markup uses framework-neutral class names (`guren-markdown-alert`, `guren-markdown-alert--note` … `--caution`, `__label`, `__body`) and the package applies no styling itself — see [Styling](#styling).

`alertLabels` overrides the rendered label text per type (requires `@guren/plugin-markdown` 0.2.0 or later), for i18n or a different vocabulary — several types may share one label, class names stay keyed to the directive that was written, and labels render as escaped text:

```ts
createMarkdownRenderer({
  alertLabels: { note: 'note', tip: 'ok', important: 'rule', warning: 'rule', caution: 'never' },
})
```

An explicit empty string suppresses the label text; omitted types keep their default (`Note`, `Tip`, `Important`, `Warning`, `Caution`).

## Heading anchors

With `anchors: true` every heading gets a slug `id` — unicode-aware, duplicate-safe within a render (`Setup`, `Setup-1`, `Setup` yields `setup`, `setup-1`, `setup-2`), and hardened against HTML smuggled into heading text.

## Link rewriting

`rewriteLink` runs over every link `href` before rendering — for example, turning GitHub-compatible relative `.md` links into site routes:

```ts
createMarkdownRenderer({
  rewriteLink: (href) => (href.endsWith('.md') ? `/docs/${href.slice(0, -3)}` : href),
})
```

## Code highlighting with shiki

`shiki` is an optional peer dependency behind its own subpath — install it only if you use it:

```bash
bun add shiki
```

```ts
import { createMarkdownRenderer } from '@guren/plugin-markdown'
import { createShikiHighlight } from '@guren/plugin-markdown/shiki'

const renderer = createMarkdownRenderer({
  highlight: createShikiHighlight({
    themes: { light: 'github-light', dark: 'github-dark' },
    langs: ['typescript', 'tsx', 'bash', 'json'],
  }),
})
```

This builds a fine-grained `shiki/core` highlighter — only the listed grammars, with the JavaScript regex engine instead of the oniguruma WASM blob — and emits dual-theme output: the light palette inline, the dark palette in `--shiki-dark` custom properties. Fences in unloaded languages fall back to plain text instead of throwing.

### On Cloudflare Workers

Bundlers that must see every import statically cannot resolve grammar names at runtime. Pass explicit module thunks instead — the thunks also keep loading lazy, so importing the module costs nothing until the first render:

```ts
createShikiHighlight({
  themes: { light: 'github-light', dark: 'github-dark' },
  themeModules: [
    () => import('shiki/dist/themes/github-light.mjs'),
    () => import('shiki/dist/themes/github-dark.mjs'),
  ],
  langModules: [() => import('shiki/dist/langs/typescript.mjs')],
})
```

Never import the full `shiki` entry in code that ends up in a Workers bundle — it pulls every grammar plus the oniguruma WASM. The full entry is fine in build-time code (prerendering docs, for example), where arbitrary languages matter more than bundle size.

### Custom highlighters

`highlight` is just a function `(code, lang) => string | Promise<string>`. A result that begins with `<pre` is treated as a complete code block and emitted as-is (shiki's shape); anything else is wrapped in the default `<pre><code>`.

## Styling

The renderer emits class names but no styles. A small reference stylesheet covers alerts and the dark-mode shiki toggle:

```ts
import '@guren/plugin-markdown/styles.css'
```

Alert accent colors are CSS custom properties, so overriding just the variables restyles them:

```css
.guren-markdown-alert--note { --guren-markdown-alert-accent: #e11d48; }
```

## As a container service

`markdownPlugin()` registers a configured renderer as the `markdown` container service:

```ts
import { createApp } from '@guren/core'
import { markdownPlugin } from '@guren/plugin-markdown'

createApp({
  providers: [markdownPlugin({ /* renderer options */ })],
})
```

```ts
import type { MarkdownRenderer } from '@guren/plugin-markdown'

const renderer = container.make<MarkdownRenderer>('markdown')
```

The plugin form is optional — `createMarkdownRenderer` works without `createApp` at all.
