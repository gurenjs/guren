---
'@guren/server': patch
'@guren/cli': patch
---

`this.authorize('create', [Post])`, and the same one-element array given to `this.can()`, `gate.allows()`, `denies()`, `authorize()` and `inspect()`, resolves `Post`'s policy and asks its record-less ability, as `this.authorize('create', Post)` does. It used to find no policy and answer 403. Any other array that names no policy (`[]`, `[record]`, three elements, a list of records) now throws an `Error` naming the accepted forms when no gate is defined for the ability, instead of denying; a gate defined for the ability still receives the array. `guren audit`'s policy suggestion for a mutating route also names the bare-class form for an ability with no record.
