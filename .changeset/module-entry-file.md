---
'@guren/cli': patch
---

A module's entry file is found by the rule `import '../modules/<name>'` resolves by: the directory's `package.json` `main`, then its `index` in any of `.ts`, `.tsx`, `.mts`, `.js`, `.jsx`, `.mjs`. `guren check --arch` already judged a module's surface this way, but descriptor reading knew only `index.ts` and `index.js`, and route loading (codegen, `guren audit`, the OpenAPI spec) imported `modules/<name>/index.ts` by name. A module kept in `index.tsx` or `index.mts` passed the arch check while the route-wiring, config and console checks read it as having no descriptor, `make:command --module` registered nothing in it, and route loading skipped it with a warning naming a file that was never there. The warnings now name the file they imported, and a module with no entry file is reported as such. A module's `./routes` entry resolves the same way, so `routes.tsx` and `routes.mts` are found too.
