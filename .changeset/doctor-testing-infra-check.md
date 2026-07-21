---
'@guren/cli': minor
---

Add a `guren doctor` check that detects missing test infrastructure. When a project's `package.json` has no `@guren/testing` in `dependencies`/`devDependencies` and no `*.test.ts`-style files exist under `tests/`, doctor now emits a warning recommending `bun add -d @guren/testing`, and the same signal appears as an actionable step in `guren doctor --next`. This closes a gap where apps scaffolded with older `create-guren-app` versions (or hand-rolled projects) had zero test infrastructure and no doctor signal about it.
