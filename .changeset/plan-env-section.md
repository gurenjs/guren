---
'@guren/cli': minor
---

Implementation plans gain an `env` section (RFC 0040 §5): the keys a change adds to `defineEnv({ … })` in `config/env.ts`, each stated as a plugin manifest states one (`key`, `type`, `choices`, `default`, `required`, `secret`, `description`). It needs `planVersion` 2, as `providers` and `config` do, and an approved plan without it keeps its hash. The checks refuse a key `guren plugin` would refuse, two elements of one key, and an added key the application already declares. `plan:status` reads `config/env.ts` from source and compares each key's builder chain with the one `guren plugin` would write for the element, `.describe()` aside, and `plan:approve` accepts an added key on its step's verified run.

`guren change:lane` reads a key added to `defineEnv()` as a new `env-added` fact, `medium`, where an edit of `config/env.ts` was `source-edited`. It is `low` when one open plan adds an element of that key and the chain declares what the element states. A key changed or removed, or anything else in the file, keeps it `source-edited`. Both readers of an entry file, this one and the `createApp()` lists', now also refuse an edit that adds or removes a comment, since a directive such as `// @ts-nocheck` is invisible to the structural comparison.
