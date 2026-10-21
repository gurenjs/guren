---
'@guren/plugin-cloudflare': minor
'@guren/cli': minor
'@guren/core': minor
---

`cloudflare:deploy` binds and creates the R2 buckets the app's disks name (RFC 0035 §2). The Cloudflare build introspects the app once, on its Workers branch, and reads two things from that run. Every disk registered with `r2Disk()` gets a bucket named `<worker>-<binding>`, or its `resourceNames` entry. The cf backend lists the bucket by name and creates it when it is missing; `gurenWorker()` then binds it. The D1 binding `config/database.ts` names is checked against the Worker's bindings. A new `resource-name` check refuses an R2 bucket name R2 would reject, before anything is created. On the Wrangler backend, an R2 binding a disk reads but `wrangler.jsonc` lacks is a `resource-missing` blocker. `inspectDeployTarget()` (`@guren/cli`) and `inspectDeployRuntime()` (`@guren/core/internal/deploy-check`) return the introspection beside the deploy-runtime verdicts. App KV is not inferred: no KV storage driver ships yet.
