---
'@guren/plugin-cloudflare': patch
---

`cloudflare:build` refuses a `wrangler.jsonc` that sets `"keep_names": false`, at the top level or in any `env.<name>` block, and accepts `"minify": true`. wrangler bundles with esbuild's `keepNames` on unless `keep_names` turns it off, so minification alone keeps class names; with `keep_names` off, a minified bundle renames every class and an unminified one renames the second of two top-level classes that share a name. The refusal now applies to every app, not only one hosting agents: queued jobs, queued events and stored notifications are keyed by class name unless they pin `static jobName`, `static eventName` or a `type` getter. An app with no agents that sets `"keep_names": false` fails the build where it passed before; remove the key, since wrangler defaults it to `true`.
