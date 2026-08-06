---
'@guren/server': patch
---

Fix CSRF verification accepting a guest token on a request that carries a session

`verifyCsrfToken` picked its validation mode from the submitted token alone: a
token without a `sid` claim took the stateless double-submit path, which only
compares the token against the `XSRF-TOKEN` cookie. Because that check ran even
when the request carried a session, a guest-mode token — which anyone can mint
by visiting the site — could authorize a state-changing request for a logged-in
user, provided the attacker also controlled the `XSRF-TOKEN` cookie. That cookie
carries no `Domain` restriction and no `__Host-` prefix, so any sibling
subdomain of the same site can set it, and a same-site request still sends the
`SameSite=Lax` session cookie. The token-minting path already enforced this rule;
only verification was missing it.

Verification now fixes the mode from the request — whether it carries a bindable
session — and requires the token to be in that mode.

Issuing had to move with it. A session created during the current request stays
`isNew` for its whole lifetime, so the response that logs a user in was minting a
guest token for a session that later requests authenticate with; under the new
rule that token would be rejected on the next mutation. `Session` gains an
optional `willPersist()` reporting whether the session survives the response
under its current id, and the CSRF cookie is now settled after the handler runs
rather than before, so a login response hands back a session-bound token.
