---
"@guren/orm": patch
---

The duplicate-copy warning no longer fires on a `bun --hot` reload. The guard counted module evaluations on `globalThis`, which survives a reload, so the first hot reload of a dev server with one installed copy printed `2 copies of @guren/orm are loaded in this process` and told the reader to realign their `@guren/*` versions. Each copy now records the module URL it was evaluated from, and a repeat of that URL counts as a reload only under `--hot`. Two different copies still warn there, and a bundle that inlines two copies at one URL still warns, because only `--hot` excuses a repeat. A re-evaluation by anything else in-process (a Vite SSR runner, `vi.resetModules()`) counts as a copy for that same reason; `GUREN_QUIET_DUPLICATE_ORM=1` silences it.
