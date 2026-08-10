---
'@guren/cli': patch
---

Refuse `make:feature` on an API-only app

The `resource` blueprint refuses an API-only app, but `guren make:feature` and
the `guren_make_feature` MCP tool reach the same page-emitting scaffold without
going through it — they wrote four React page components plus a controller
importing `@/.guren/pages.gen`, then exited 0. `makeFeature` now runs the same
`assertNotApiOnly` refusal before its first write, judged against the project it
scaffolds into (`cwd`) rather than the process directory, which is what the MCP
server names.

Detection is the shared positive-evidence rule: a readable `package.json` that
does not declare `@guren/inertia-client`, **and** no `routes/web.ts` or
`routes/web.js` — every "cannot tell" permits the scaffold. The single-file
generators are deliberately left out: `make:controller` emits an Inertia
controller and `make:view` a page component, but one stray file is a deletion,
not the multi-file mess the guard exists to prevent.
