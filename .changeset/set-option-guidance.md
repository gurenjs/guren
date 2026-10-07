---
"@guren/cli": patch
---

Point the force-write audit fix and the agent harness at `create(data, { set })` (RFC 0031). The `force-write-request-data` suggestion now rewrites `forceCreate({ ...data, authorId: user.id })` as `create(data, { set: { authorId: user.id } })`, and the harness rules, skills and code-review checklist keep owner columns out of `fillable` and write them through `set`, leaving force writes to seeders, system records and OAuth hash sentinels. `bunx guren agent:sync` refreshes the rules, skills and agents; the example in an existing `CLAUDE.md` is the app's own and is not rewritten.
