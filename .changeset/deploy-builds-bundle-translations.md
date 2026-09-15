---
"@guren/server": patch
"@guren/core": patch
"@guren/plugin-cloudflare": patch
"@guren/plugin-lambda": patch
"@guren/plugin-vercel": patch
---

A deployed app now renders its translations. `createApp({ i18n })` reads `lang/<locale>/*.json` from the filesystem, which Cloudflare Workers, AWS Lambda and Vercel functions do not ship, so the default scaffold's home page showed `messages.welcome` instead of its welcome text and the logs reported `no translations loaded for locale 'en'`.

`guren cloudflare:build`, `guren lambda:build` and the Vercel build now read `lang/` at build time and inject the catalogs as `GUREN_TRANSLATIONS`. When the app passes neither `loader` nor `path`, the i18n provider serves the injected catalogs through a `MemoryLoader`. An explicit `loader` still wins, and a `lang/` file that is not valid JSON is left out with a build warning. `GUREN_TRANSLATIONS` holding something other than a catalog object fails the boot.
