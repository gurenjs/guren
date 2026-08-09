---
'@guren/server': patch
---

Key the OAuth session binding by state, not by one shared slot

`authorize({ session })` parked its binding under a single session key and
`handleCallback({ session })` deleted that key regardless of which state the
callback carried. Two consequences, both measured:

- A browser could only have one flow in flight. Open two tabs, or start over
  with a different provider, and the second `authorize()` overwrote the first's
  binding — so at least one login failed. Completing the older flow first failed
  *both*, because it consumed the newer flow's binding on its way out.
- A callback carrying a state the browser never started still stripped the
  binding. Anyone could navigate a visitor to `/callback?code=x&state=x`
  mid-login and lock them out of the login they had actually begun.

Bindings are now filed under the hash of the state they belong to, and a
callback takes only its own. Concurrent flows are independent, and a forged
callback finds nothing to remove. The list is capped at five pending flows per
browser and prunes expired entries as it goes.

`OAUTH_SESSION_BINDING_KEY` and `OAuthBindingSession` are also exported from
`@guren/server` and `@guren/core`, which the previous change documented as
public API but left reachable only through the deep module path.
