---
'@guren/server': minor
---

Serve fonts from `public/` by default. `.woff2`, `.woff`, `.ttf` and `.otf` join `DEFAULT_ROOT_PUBLIC_ASSET_EXTENSIONS` and are served as `font/woff2`, `font/woff`, `font/ttf` and `font/otf`. A self-hosted font such as `public/fonts/x.woff2` named from CSS used to return 404 in development, `bun run preview` and Bun production while Cloudflare Workers Static Assets served it. An app that spreads `DEFAULT_ROOT_PUBLIC_ASSET_EXTENSIONS` into `rootPublicAssets.extensions` picks the fonts up too. One that lists its own `extensions` still serves only what it lists, but no longer needs a `contentTypeMap` entry for a font extension it names.
