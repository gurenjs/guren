---
"create-guren-app": patch
"@guren/cli": patch
"@guren/server": patch
---

Keep scaffolded apps and the framework compiling under TypeScript 7.

- Scaffolded `tsconfig.json` no longer sets `baseUrl`, which TypeScript 7 rejects (TS5102); `paths` already resolves from the tsconfig directory without it.
- `guren doctor` warns on a root `baseUrl` (TypeScript 7 rejects it), and its autofix removes one while adding the `@/*` alias.
- A `resources/js/vite-env.d.ts` declares the virtual `@vite/client` module, since TypeScript 6+ checks that side-effect imports resolve.
- The dev banner's JSON import uses the standard `with { type: 'json' }` attribute instead of the removed `assert` form.
