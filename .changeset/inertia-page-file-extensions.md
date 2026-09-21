---
"@guren/cli": patch
---

List only the page component extensions the client can render. `guren check`, `guren context`, `spec:generate` and `plan:status` no longer report a `.ts` or `.js` file under `resources/js/pages/` as a page: the scaffolded client entry globs that directory for `.tsx`, and codegen registers `.tsx` and `.jsx` in `.guren/pages.gen.ts`, so such a file is not a page the app can load.

The extension list is now one constant shared by the page lister, the component-file resolver, and the codegen that writes the manifest, which is what let the three disagree.
