---
'@guren/server': patch
'@guren/cli': patch
---

Let OAuth `state` be bound to the browser that started the flow

`createOAuthState` stored `{ provider, redirectTo, expiresAt }` and
`verifyOAuthState` checked only that the provider matched. Nothing tied the
state to a browser, and the manager is a process-wide singleton, so a state
minted for one browser was consumable by any other. `state` was unguessable and
single-use, but *transferable* — which is the one property it exists to prevent
(RFC 6749 §10.12).

That is login CSRF. An attacker requests `/auth/github` on the target app and
captures the `state` from the redirect, separately authorizes the app against
their own provider account and captures the `code` without letting their browser
reach the callback, then induces a visitor into a top-level navigation to
`/auth/github/callback?code=…&state=…`. The state verifies, the code exchanges
for the attacker's profile, and the visitor's session is logged into the
attacker's account. The visitor keeps using the app believing it is theirs, so
whatever they write next — posts, uploads, a connected payment method — lands in
an account the attacker can read. It could not be fixed from application code:
`handleCallback()` verified state internally and accepted no session-bound value.

`authorize()` now takes `bindTo` and `handleCallback()` takes it back. Only a
hash of the value reaches the state store, and comparison is timing-safe. Pass a
value only that browser can present — a session id, or a random value stored in
the session, which also makes a logged-out visitor's session persist across the
round trip.

A state created without a binding still verifies, so apps written against the
earlier API keep working; `authorize()` warns once per process when called
without `bindTo`, and those apps stay exposed until they adopt it. `make:auth`,
the `oauth` blueprint, the docs, and the blog example all pass it now.
