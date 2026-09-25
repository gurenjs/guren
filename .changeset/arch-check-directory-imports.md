---
'@guren/cli': patch
---

`guren check --arch` resolves an import of a directory through its index file. `import x from '../modules/newsletter'`, the form `make:module` writes into `src/app.ts`, resolved to the directory itself, which matched neither a `modules/newsletter/**` rule in `guren.arch.ts` nor the built-in module boundary rule, so the import passed unjudged. It now resolves to `index.ts`/`.tsx`/`.js` (and `index.d.ts` for a type-only import), and a directory with no index is unresolved: a `guren.arch.ts` rule covering the importer warns about it, and the built-in module boundary rule, which judges only resolved files, leaves it alone (such an import does not compile). A module whose descriptor is `index.js` counts as its public surface too.
