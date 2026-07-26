---
"@guren/cli": patch
---

fix: `guren upgrade` aligns `drizzle-orm` and `drizzle-kit` with what `@guren/orm` depends on

`@guren/orm` names an exact `drizzle-orm` version under `dependencies`, not a
range. Upgrading only the `@guren/*` entries therefore left apps pinning a
different one with two copies installed:

```
node_modules/drizzle-orm                         -> 1.0.0-rc.1   (the app's pin)
node_modules/@guren/orm/node_modules/drizzle-orm -> 1.0.0-rc.4   (what the ORM brings)
```

The app builds its table descriptors against one copy while the adapter runs on
the other — the same split-state hazard the duplicate-`@guren/orm` warning
exists for, and `guren upgrade` was the step that introduced it. `CLAUDE.md`
already tells contributors to keep these versions aligned; nothing enforced it
for apps.

The command now reads the `drizzle-orm` version the target `@guren/orm` depends
on straight from its registry metadata and writes that, exactly, to both
`drizzle-orm` and `drizzle-kit`. It only acts on apps that declare `@guren/orm`
and already have a drizzle entry, never adds one, and leaves both alone when the
pin cannot be read.

`drizzle-kit` is matched to `drizzle-orm` by convention rather than from
metadata: it is not a dependency of `@guren/orm`, so the registry has nothing to
say about it — the two simply ship as a pair, which is what the templates and
`packages/orm` already assume.
