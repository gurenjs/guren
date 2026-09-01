---
"@guren/core": minor
---

Export the attachments object-key prefix as `ATTACHMENT_OBJECT_PREFIX` instead of restating the literal at every site that builds a storage key.

The attachments engine spelled `attachments/` out at six independent sites: the original's key, a variant's key, the HEIC-conversion rewrite, both `deleteDirectory` purges, and the prune sweep's `directories()` listing. That layout is not private to the engine, which is why the duplication matters more than duplication usually does. `guren check`'s attachments rules judge, from `@guren/cli`, whether uploaded bytes land somewhere the app serves statically, and the ones that reach the objects themselves have to name the same `<disk root>/attachments`. Nothing makes the two agree, and the way they come apart is silent: if the layout ever moved (a shard level, a rename), the rule over there would not fail loudly, it would stop matching, answer "not reachable", and report an exposed app as safe. A build-failing security rule failing *open*, with nothing going red anywhere.

`ATTACHMENT_OBJECT_PREFIX` is exported from `@guren/core` so that rule can import the layout rather than restate it, and the engine now builds every key from it. Two tests keep the single source structural: the constant must stay reachable through core's barrel — an allowlist for these names, not `export *`, so a name missing from it is unreachable however it is exported below — and the engine's source may not re-hardcode the prefix. That second one is a source-level check on purpose: nothing at runtime distinguishes a key built from the constant from one built from a re-typed literal.

No behaviour changes; the keys are byte-identical.
