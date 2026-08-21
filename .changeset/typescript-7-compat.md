---
"create-guren-app": patch
"@guren/cli": patch
"@guren/server": patch
---

Keep scaffolded apps and the framework compiling under TypeScript 7.

- Scaffolded `tsconfig.json` no longer sets `baseUrl`, which TypeScript 7 rejects (TS5102); `paths` already resolves from the tsconfig directory without it.
- `guren doctor` no longer recommends or writes `baseUrl` when repairing the `@/*` alias.
- The `@vite/client` side-effect import in the scaffolded `dev-entry.ts` carries a `@ts-ignore`, since TypeScript 6+ checks that side-effect imports resolve and the module is virtual.
- The dev banner's JSON import uses the standard `with { type: 'json' }` attribute instead of the removed `assert` form.
