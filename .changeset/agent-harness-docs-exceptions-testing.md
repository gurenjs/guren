---
"@guren/cli": patch
---

Fix and expand the AI agent harness template (`.claude/rules/*.md`, `.claude/skills/guren-api/SKILL.md`, `CLAUDE.md`) shipped by `agent:init`/`agent:sync`:

- Document the `HttpException`/`ValidationException`/`AuthenticationException`/`AuthorizationException`/`NotFoundHttpException` factory methods in a new "Exceptions" section — previously only findable by grepping `node_modules/@guren/server/dist/*.d.ts`.
- Note that `this.auth.userOrFail()`'s `<T>` defaults to `Authenticatable`, which has no `.id`, and fix the `userOrFail()` examples across the templates to use `userOrFail<UserRecord>()` so copy-pasted code type-checks.
- Note that array-typed relations (`hasMany`, etc.) need a `[]` placeholder in `relationTypes`, not `null`.
- Note that Guren has no global shared Inertia props by default (`shareInertiaProps()` exists but a fresh scaffold never calls it), so `usePage()` for undeclared props silently resolves to `undefined`.
- Document `TestApp.create()`'s `auth` option and CSRF testing pattern, and add a "Testing (@guren/testing)" section to the `guren-api` skill (previously absent from the subsystem list entirely).
- Change the `guren-api` skill's frontmatter `description` from a purely reactive framing ("use when user asks...") to also prompt proactive use during implementation, before falling back to grepping dist files.
