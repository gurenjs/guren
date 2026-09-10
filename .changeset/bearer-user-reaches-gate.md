---
"@guren/server": patch
---

Make the user `createBearerTokenMiddleware({ loadUser })` loads visible to the Gate

The middleware stored the loaded user under `guren:user`, a key nothing in
authorization reads: `Gate.resolveUser` consults the attached auth context
first and then `ctx.get('user')`, so a policy check on a bearer-authenticated
request saw no user at all. The middleware now also attaches an auth context
answering with the loaded user, which is what `Gate`, `requireAuthenticated()`
and `Controller.auth` read. `ctx.get('guren:user')` keeps working. A
`loadUser` that returns `null` leaves the request unauthenticated.
