---
'@guren/cli': minor
'@guren/plugin-cloudflare': patch
---

`guren doctor` gains a `cloudflare-html-handling` check, and `guren upgrade` applies its fix: an app whose `wrangler.jsonc` serves `assets` from `.cloudflare/assets` without `"html_handling"` gets `"html_handling": "none"` added there, with the comments and formatting of the file kept. Without the key, Workers Static Assets serves `public/about.html` at `/about`, where the `/*.html` rule in `_headers` does not reach it and where it shadows a route of that name. The Cloudflare build still never edits an existing `wrangler.jsonc`.

The check reports, and leaves for you to edit, an `assets` object under `env.<name>` that lacks the key, one that serves another directory, and a value other than `"none"`. An app that deploys through `cloudflare.config.ts` passes, since `wrangler.jsonc` is not read there.

The build now also warns when `"html_handling"` is set to a value other than `"none"`, saying what that value leads to. The value is left as it is.
