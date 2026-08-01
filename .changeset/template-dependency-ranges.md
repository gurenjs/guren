---
"create-guren-app": patch
---

Point the templates' `@guren/*` ranges at the versions they are published with

Every template declared `"@guren/orm": "^1.0.0"` and friends, unchanged since
1.0. A template's `package.json` is the one file in the repository that resolves
against **npm** rather than the workspace, so those ranges decided what a
scaffolded app actually installed — 1.3.0 for an ORM the templates had long
since outgrown. `bun run typecheck` in a fresh app failed on
`config/database.ts`, which imports the dialect-aware `SqliteSeederContext` that
only exists in this repository so far.

Releasing does not fix that on its own: the pending changesets take
`@guren/orm` to 2.0.0, and a caret range cannot cross a major. `@guren/core` is
on a minor line, so the same app would have installed core 1.5.0 — which depends
on orm 2.0.0 — next to orm 1.3.0, putting two copies of the ORM in one process.

`scripts/sync-template-deps.ts` now writes the ranges from the workspace
versions, `version-packages` runs it immediately after `changeset version`
(the first moment the new numbers exist), and the new `audit:template-deps`
gate asserts they agree, so a range that falls behind fails CI on the PR that
caused it. Because a rewritten template only reaches users inside a new
`create-guren-app` tarball — and `create-guren-app` declares no `@guren/*`
dependency for changesets to follow — the release path also fails if the
templates changed without `create-guren-app` being bumped.

None of the existing smokes could see any of this: `smoke:starter` and
`smoke:starter:packed` both rewrite the scaffolded app's `@guren/*` dependencies
to builds of the local checkout. The new `smoke:starter:npm` mode leaves the
template's declared ranges alone and installs from the registry, and runs on a
scheduled `Published Package Drift` workflow rather than in CI — it is correctly
red between a template-facing change and the release that publishes what the
template needs.
