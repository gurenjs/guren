# @guren/plugin-markdown

## 0.3.0

### Minor Changes

- 3eea236: Add a `rewriteImage` option to `createMarkdownRenderer()`, mirroring `rewriteLink` for image `src` attributes. The two resolve against different roots in practice — a markdown link points at another document, an image at a served asset — so an app that rewrites one usually needs to rewrite the other differently.
- 3b55863: Serve opt-in root public assets with the right content type, and export `escapeHtml`.

  `registerRootPublicAssets` now knows the content types for `.js`, `.mjs`, and `.css`. They stay out of the default extension allowlist, so nothing new is exposed — but an app that opts one in no longer has to restate its type to stop the browser refusing an `application/octet-stream` script or stylesheet.

  `@guren/plugin-markdown` exports `escapeHtml`, which consumers passing `sanitize: false` need for anything they hand back through the `highlight` callback.

### Patch Changes

- Updated dependencies [327b4b5]
- Updated dependencies [1161036]
  - @guren/core@1.12.0

## 0.2.1

### Patch Changes

- 8871c4c: Build with tsdown instead of tsup, and emit declarations with the native TypeScript 7 compiler. The public file layout of every package is unchanged (same `dist/*.js` / `dist/*.d.ts` entry names, shebangs, and `exports`); only the internal chunk names differ. tsup is unmaintained and its declaration bundler needs the JavaScript compiler API that TypeScript 7 no longer ships.
- Updated dependencies [deaa5c0]
- Updated dependencies [8871c4c]
  - @guren/core@1.8.1

## 0.2.0

### Minor Changes

- a70e741: Add an `alertLabels` renderer option overriding the label text per alert type (i18n, or a different vocabulary — several types may share one label). Class names are unaffected, and omitted types keep their default label.
