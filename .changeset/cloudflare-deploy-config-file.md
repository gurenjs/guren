---
"@guren/plugin-cloudflare": minor
"@guren/cli": patch
---

`config/cloudflare.ts` holds Guren's deploy settings on the `cf` backend (RFC 0035 §3): `defineCloudflareConfig({ mcpOAuth, mcpPath, resourceNames })` from `@guren/plugin-cloudflare/config`. `cloudflare:build` and `cloudflare:deploy` read it, and the running app never does. `mcpOAuth` and `mcpPath` replace the flags there: a flag the file contradicts is refused, and a flag the file leaves unset is used with a warning. `resourceNames` overrides the default resource name per binding: the D1 database the build binds by name, and the KV namespace the plan resolves and creates. A file of the wrong shape fails the build. `guren check` no longer reports `config/cloudflare.ts` as an unwired config definition.
