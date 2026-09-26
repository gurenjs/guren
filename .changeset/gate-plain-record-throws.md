---
"@guren/server": minor
"@guren/core": minor
---

`Gate` now throws when a plain record resolves no policy and no gate. `this.authorize('delete', comment)` with an ORM record (an object literal or a null-prototype object, which carries no class the gate can find a policy by) used to deny with a generic 403, so the record's own owner was refused with nothing naming the cause. When no gate is defined for the ability either, the check now throws an `Error` naming the ability and the fix: pass `[Model, record]`, or define a gate for the ability.

What still works as before: a `before()` callback that answers, a gate defined for the ability (`gate.define('update-post', (user, post) => …)` receives the plain record), a bare class (`authorize('create', Comment)`), and the tuple forms. A class instance whose class has no policy, and a tuple whose model has none, are still denied.

This is a behaviour change for code that relied on the silent denial, including `can()` / `allows()`, which now throw rather than return `false` for such a record. `gate.any()` and `authorizeMiddleware()` given an array check abilities in order, so a plain record throws at the first ability that resolves nothing, even where a later ability (an `admin` gate, say) would have allowed the request. Pass `[Model, record]` in those calls. The throw also skips `after()` callbacks, which see no result for such a check.
