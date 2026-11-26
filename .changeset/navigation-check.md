---
"@guren/cli": minor
---

`guren check` reads `config/navigation.ts` and judges each entry against the app as it registers. It reports, as advisory warnings, a route the runtime would hide (not registered, not a `GET`, a path parameter), a route whose action renders no page, an entry shown to guests whose route requires sign-in, an ability the action authorizes that the entry's `can` does not name or names otherwise, and a `can` the gate cannot answer without a record. The file is read by its syntax and never run.
