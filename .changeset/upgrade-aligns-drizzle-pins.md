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
`drizzle-orm` and `drizzle-kit`. It only rewrites entries that already exist,
never adds one, and stands down rather than guessing when:

- the entry names a location instead of a release (`workspace:`, `file:`,
  `catalog:`, a git URL) — usually a local drizzle build being developed
  against, which a registry release would silently replace;
- the field is `peerDependencies` or `optionalDependencies` — a peer range is a
  compatibility window a library publishes, not an installed copy to dedupe, and
  narrowing it to one exact version shrinks what that library claims to support;
- `@guren/orm` depends on a range rather than one exact version — deduping only
  works when there is a single version to converge on;
- the version was never published for `drizzle-kit`.

That last one matters because `drizzle-kit` is matched by convention, not from
metadata: it is not a dependency of `@guren/orm`, so the registry says nothing
about it, and the two packages have not always shared a release line. Writing a
`drizzle-kit` version that does not exist would break the next install, so its
existence is checked first and the entry is left alone with a warning otherwise.

The lookups read one published version's manifest
(`registry.npmjs.org/<name>/<version-or-tag>`) rather than the package's full
document: `@guren/orm/latest` is 2 KB and carries the version *and* its
dependencies in a single request, where the abbreviated packument is 28 KB — and
`drizzle-kit`'s is 1.2 MB, which is what checking one version used to cost. That
adds one request when the pins already agree and two when they have drifted; a
package appearing in both `dependencies` and `devDependencies` is still asked
about once. `--tag canary` returns before any of it, so that mode stays
offline.
