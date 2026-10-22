---
"@guren/plugin-cloudflare": patch
---

Two fixes to `cloudflare:deploy` on the cf backend, found deploying a scaffolded SSR app to a real account:

- It now works for an app with Vite in its `package.json` (every SSR scaffold). `cf build` handed such an app to `vite build`, which writes no Worker, so the plan failed before reading the account. The plugin now builds through Wrangler's cf implementation, which preflight checks for.
- It no longer stops after creating an R2 bucket with "binds MEDIA to another resource". The check compared the bucket's binding by id, which R2 does not have.
