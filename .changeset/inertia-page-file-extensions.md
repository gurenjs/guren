---
"@guren/cli": patch
---

List only the page component extensions the client can render. `guren context`,
`spec:generate` and `plan:status` no longer report a `.ts` or `.js` file under
`resources/js/pages/` as a page: the scaffolded client entry globs that directory
for `.tsx`, and codegen registers `.tsx` and `.jsx` in `.guren/pages.gen.ts`, so
such a file is not a page the app can load. An app that keeps such a file and
commits `docs/spec/` should re-run `guren spec:generate`: until then
`guren check --spec`, `check --ci` and `guren gate` report `screens.md` as out of
date.
