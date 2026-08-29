---
"@guren/server": patch
"@guren/plugin-markdown": minor
---

Serve opt-in root public assets with the right content type, and export `escapeHtml`.

`registerRootPublicAssets` now knows the content types for `.js`, `.mjs`, and `.css`. They stay out of the default extension allowlist, so nothing new is exposed — but an app that opts one in no longer has to restate its type to stop the browser refusing an `application/octet-stream` script or stylesheet.

`@guren/plugin-markdown` exports `escapeHtml`, which consumers passing `sanitize: false` need for anything they hand back through the `highlight` callback.
