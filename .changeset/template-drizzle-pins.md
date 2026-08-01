---
"@guren/cli": patch
---

Generate the templates' drizzle pins from `packages/orm`, by the rule `guren upgrade` already owns

`scripts/sync-template-deps.ts` kept the templates' `@guren/*` ranges pointed at
the workspace versions, but it filtered on `@guren/`, so `drizzle-orm` and
`drizzle-kit` in `packages/create-app/templates/*/package.json` were still
matched to `packages/orm/package.json` by hand. That pairing is exactly what the
`@guren/*` sync exists to prevent: `@guren/orm` names an *exact* `drizzle-orm`
version under `dependencies`, so a template pinning a different one scaffolds an
app with a second nested copy — the app builds its table descriptors against one
copy while the adapter runs on the other.

The rule now lives in one place, `packages/cli/src/drizzle-pins.ts`, and takes a
manifest plus `@guren/orm`'s own manifest. `guren upgrade` passes the published
one for the tag it is upgrading to, exactly as before; the sync passes
`packages/orm/package.json` and applies the result to every template. Nothing
about the upgrade path changes — the planner returns the rewrites instead of
performing them, so `--check` can report the same verdict it would write.

Refusals are part of that verdict, not narration. Everything the rule declines to
rewrite comes back with a reason, because a caller reading only the changes would
take "there is drift here I will not touch" for "aligned" — which is how a
template pinned at `workspace:*` used to leave the CI gate reporting a match.
`guren upgrade` prints all of them and moves on, since the app manifest is the
user's to edit; the sync fails on the two a maintainer can fix in this repository
(a specifier naming a location, and a `packages/orm` that stopped pinning one
exact version), and tolerates the two about npm rather than this checkout.

`drizzle-kit` stays the one version a human still picks when the pair diverges:
it is not a dependency of `@guren/orm`, only of apps and templates, and the two
packages have never shared numbers on their stable lines. Both callers check the
companion release exists before writing it, and say what they left alone when it
does not:

```
packages/create-app/templates/default/package.json: drizzle-kit@1.0.0-rc.4-de6c356
does not exist on npm — leaving devDependencies.drizzle-kit at "1.0.0-rc.4". Pick
the drizzle-kit release matching drizzle-orm 1.0.0-rc.4-de6c356 yourself.
```

`audit:template-deps` and `sync:template-deps` share that lookup, so anything the
CI gate reports as drift the sync can actually fix. An aligned manifest
short-circuits before any request, which is the steady state CI runs in — the
gate stays offline until a pin actually moves. When it does move and npm cannot
answer, that is a refusal too, not a crash: an npm outage says so and leaves the
companion alone rather than failing a PR that touched nothing related.
