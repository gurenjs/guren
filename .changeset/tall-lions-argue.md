---
"@guren/cli": minor
---

`guren check --arch` can now enforce boundaries at the type level. Type-only imports (`import type`, `export type ... from`, and `import('...').X` in a type position) still compile away and are skipped by default, but a rule — or the whole rule set — can opt in with `includeTypeImports: true`, and the `defineArchRules` JSDoc now states the default explicitly. Violations found this way are labeled `(type-only)` in the report.
