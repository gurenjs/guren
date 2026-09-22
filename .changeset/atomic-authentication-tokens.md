---
"@guren/server": minor
"@guren/core": patch
"@guren/cli": patch
---

Consume password reset and email verification tokens atomically before invoking application updates. Replace tokens per normalized email atomically so concurrent reissuance leaves only one valid token. Memory and Redis stores implement the new operations; custom stores must implement `replace` and `consume` to use the issuance and completion helpers. Failed updates require a new token.

Generate password reset controllers that use the atomic completion helper. The helper only requires a provider's credential lookup, allowing applications to use their existing record types.
