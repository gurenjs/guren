---
"@guren/plugin-markdown": minor
---

Add a `rewriteImage` option to `createMarkdownRenderer()`, mirroring `rewriteLink` for image `src` attributes. The two resolve against different roots in practice — a markdown link points at another document, an image at a served asset — so an app that rewrites one usually needs to rewrite the other differently.
