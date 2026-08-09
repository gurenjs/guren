---
'@guren/server': minor
'@guren/cli': patch
---

Let the OAuth manager keep the browser binding in the session itself

Binding a flow via `bindTo` worked but pushed four steps into every
controller: mint a random value, store it in the session, read it back in the
callback, forget it — guarded on the session existing, twice. Every scaffold
and example carried the same twelve lines.

`authorize()` and `handleCallback()` now also accept a `session`. Hand them
`this.auth.session()` and the manager mints the per-flow binding, parks it in
the session under `OAUTH_SESSION_BINDING_KEY`, and consumes it during callback
verification — reading and removing it in one step, so a replayed callback
finds nothing. A missing session (no session middleware) flows through as an
unbound state exactly as before, warning included. The parameter is typed as
`OAuthBindingSession` — the three session methods the manager needs — so the
framework session satisfies it structurally and tests can pass a plain stub.

`bindTo` remains for bindings kept elsewhere (an encrypted cookie, secure
storage) and takes precedence when both are given. `make:auth`, the `oauth`
blueprint, the docs, and the blog example now pass `session` instead of
hand-rolling the plumbing.
