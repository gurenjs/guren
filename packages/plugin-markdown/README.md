# @guren/plugin-markdown

Markdown-to-HTML rendering for [Guren](https://guren.dev/) applications: GitHub Flavored Markdown, sanitized output by default, GitHub-style alerts, heading anchors, and optional shiki code highlighting (RFC 0012).

```bash
bunx guren plugin @guren/plugin-markdown
bun add @guren/plugin-markdown
```

## Rendering

```typescript
import { createMarkdownRenderer } from '@guren/plugin-markdown'

const renderer = createMarkdownRenderer()
const html = await renderer.render('# Hello\n\n> [!NOTE]\n> Sanitized by default.')
```

`render()` is a pure async function — render at save time and store the HTML, or render per request; the package has no cache and no opinion.

Defaults (all overridable):

- **`sanitize: true`** — output passes a `sanitize-html` allowlist tuned for markdown plus shiki's inline styles: `javascript:`/`data:`/protocol-relative URLs are dropped, raw HTML is escaped, only shiki-shaped style declarations survive. The rendered HTML is safe to inject with `dangerouslySetInnerHTML`. Pass `false` for trusted content, or a callback to extend the allowlist:

  ```typescript
  createMarkdownRenderer({
    sanitize: (defaults) => ({
      ...defaults,
      allowedTags: [...(defaults.allowedTags as string[]), 'video'],
    }),
  })
  ```

- **`alerts: true`** — `> [!NOTE]` / `[!TIP]` / `[!IMPORTANT]` / `[!WARNING]` / `[!CAUTION]` blockquotes become labeled alert blocks with `guren-markdown-alert` class names.
- **`anchors: true`** — headings get slug `id`s (unicode-aware, duplicate-safe, hardened against HTML smuggled into heading text).
- **`rewriteLink`** — hook over every link `href`, e.g. rewriting relative `.md` links to routes.
- **`highlight`** — code-fence highlighter, `(code, lang) => string | Promise<string>`.

## Shiki highlighting

`shiki` is an optional peer dependency behind its own subpath — install it only if you use it:

```bash
bun add shiki
```

```typescript
import { createMarkdownRenderer } from '@guren/plugin-markdown'
import { createShikiHighlight } from '@guren/plugin-markdown/shiki'

const renderer = createMarkdownRenderer({
  highlight: createShikiHighlight({
    themes: { light: 'rose-pine-dawn', dark: 'rose-pine-moon' },
    langs: ['typescript', 'tsx', 'bash', 'json'],
  }),
})
```

This builds a fine-grained `shiki/core` highlighter (only the listed grammars, JavaScript regex engine — no oniguruma WASM) and emits dual-theme output: the light palette inline, the dark palette in `--shiki-dark` custom properties. Fences in unloaded languages fall back to plain text.

Bundlers that must see every import statically (Cloudflare Workers builds) should pass explicit modules instead of names:

```typescript
createShikiHighlight({
  themes: { light: 'rose-pine-dawn', dark: 'rose-pine-moon' },
  themeModules: [
    import('shiki/dist/themes/rose-pine-dawn.mjs'),
    import('shiki/dist/themes/rose-pine-moon.mjs'),
  ],
  langModules: [import('shiki/dist/langs/typescript.mjs')],
})
```

## Styling

The renderer emits class names but no styles. A small reference stylesheet covers alerts and the dark-mode shiki toggle:

```typescript
import '@guren/plugin-markdown/styles.css'
```

## As a plugin

```typescript
import { markdownPlugin } from '@guren/plugin-markdown'

createApp({
  providers: [markdownPlugin({ /* renderer options */ })],
})
```

The provider binds the configured renderer as the `markdown` container service:

```typescript
import type { MarkdownRenderer } from '@guren/plugin-markdown'

const renderer = container.make<MarkdownRenderer>('markdown')
```
