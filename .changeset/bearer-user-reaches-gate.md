---
"@guren/server": patch
---

Make the user `createBearerTokenMiddleware({ loadUser })` loads visible to the Gate

The middleware stored the loaded user under `guren:user`, a key nothing in
authorization reads: `Gate.resolveUser` consults the attached auth context
first and then `ctx.get('user')`, so a policy check on a bearer-authenticated
request saw no user at all. Wrapping the attached context instead would only
have moved the problem, since `AuthServiceProvider` attaches its own context
during `boot()` and overwrites whatever the middleware left.

The middleware now records the principal it resolved on the request, under
`RESOLVED_PRINCIPAL_KEY`, and the framework auth context answers `check()`,
`user()`, `id()` and `logout()` from it before reaching a guard. The user
therefore reaches `Gate`, `requireAuthenticated()` and `Controller.auth`
whether the middleware is mounted before or after `boot()`. `logout()` revokes
the presented token and leaves a co-present session alone, as `TokenGuard`
does; a successful `login()` or `attempt()` replaces the principal, so the
request's identity follows the login. `user()` is sanitized through the
provider `useTokens({ provider })` configured, so a password hash cannot leave
the auth layer. An identity the invocation pipeline installed still wins
(RFC 0017 §2). `ctx.get('guren:user')` keeps working.

A `loadUser` that returns `null` leaves the request unauthenticated even beside
a logged-in session: the token verified, so that request is the token's.
A request the middleware never ran for is untouched.
