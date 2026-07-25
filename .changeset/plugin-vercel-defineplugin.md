---
'@guren/plugin-vercel': minor
'@guren/cli': minor
---

BREAKING (`@guren/plugin-vercel`): the provider export changed from the `GurenPluginVercelProvider` class to a `vercelPlugin(config?)` factory built on `definePlugin()`, aligning with `@guren/plugin-cloudflare` and the plugin contract's recommended shape. The config object is empty today and reserved so future fields never force another registration-shape change. Update registrations from `providers: [GurenPluginVercelProvider]` to `providers: [vercelPlugin()]`; `createVercelHandler` and `buildVercelOutput` are unchanged. The `gurenPlugin.provider` manifest field is dropped accordingly.

`@guren/cli`: `guren plugin` now knows the official factory-shaped plugins (`@guren/plugin-vercel`, `@guren/plugin-cloudflare`) and auto-registers them as `providers: [vercelPlugin()]`-style call expressions in `src/app.ts` — previously factory plugins could only print a "register manually" hint.
