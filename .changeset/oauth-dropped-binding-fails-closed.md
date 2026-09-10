---
"@guren/server": patch
---

Reject an OAuth callback whose stored state lost its browser binding

`verifyOAuthState` accepted a state that came back from the store with no
`binding` even when the caller presented one, so an `OAuthStateStore` that
drops the field (a `oauth_states` table with no `binding` column) silently
turned a bound flow back into a transferable one, with only a one-shot
`console.warn` to say so. A bound flow now fails on a missing binding on
either side, the same as on a mismatch. The warning stays, so a store author
sees why the callback was rejected. Flows bound on neither side still verify.
