---
"@guren/cli": minor
---

Fix `make:resource --model` generating code that doesn't type-check: it referenced the model's class name (`Resource<Comment>`) instead of its inferred record type, and unconditionally called `.toISOString()` on `createdAt`/`updatedAt` even when the Drizzle schema stores them as `text()` (ISO strings), which throws at runtime. The generated resource now imports and extends `Resource<XRecord>` and leaves timestamp mapping to the developer instead of guessing the column type.

Fix `make:test` defaulting to a `vitest` import even in projects with no vitest installed (scaffolded apps ship `bun test`, not vitest) — the runner is now auto-detected from `vitest.config.*` / a `vitest` dependency in `package.json`, falling back to `bun:test`; `--runner` still overrides detection when passed explicitly.

Add the `--controller` flag to `make:test`, which `guren check`'s remediation message already referenced but which didn't exist — it now suffixes the class name with `Controller` and writes to `tests/controllers/${ClassName}.test.ts`, matching `guren check`'s first lookup candidate.
