---
"@guren/server": minor
---

Reject an OAuth callback whose stored state lost its browser binding

`verifyOAuthState` read boundness only from the payload the store returned, so
an `OAuthStateStore` that drops `binding` (an `oauth_states` table with no
`binding` column) inverted the protection: the honest callback, which presents
a binding the store cannot match, was rejected, while the session-fixation
callback was accepted, because a victim's browser presents no binding either
and a stored `undefined` beside a presented `undefined` read as an unbound
flow. Only a one-shot `console.warn` marked the difference.

A bound state now carries a marker in the state value itself, minted by
`createOAuthState` before the state is hashed into the store key. Boundness
therefore survives a store that keeps nothing, and cannot be edited off a state:
changing any byte changes the key the store was written under, so the lookup
misses. A bound flow whose payload comes back without its binding fails, and
warns per occurrence rather than once per process.

**Before upgrading, give the `oauth_states` table its `binding` column.** A
store that drops the column now fails every bound callback instead of silently
downgrading it. States minted before the upgrade keep verifying: they carry no
marker, and a store that keeps `binding` compares the two sides as before.

Bound flows that pass their own `state` to `authorize()` get it back carrying
the marker. Send the `state` `authorize()` returns, not the one passed in.
