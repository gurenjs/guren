---
'@guren/cli': minor
---

`guren.arch.ts` takes `moduleBoundaries: { includeTypeImports: true }`. With it, the zero-config module boundary check also fails a type-only import that reaches past a module's `index.ts` or `db/schema.ts`, labelled `imports (type-only)`. The default is unchanged, and the set-wide `includeTypeImports` still covers declared rules only. An unknown key or a non-boolean value under `moduleBoundaries` is reported as a config error rather than read as off.
