---
'@guren/server': patch
---

Under `NODE_ENV=production`, the `log` mail transport replaces the values of `token` and `signature` query parameters with `[redacted]`. These are where password reset, email verification and signed links carry their credential, and the `log` driver is the scaffolded default when no transport is configured, so a deployment that never set one wrote working reset links to its logs. Every other part of the message, other query parameters and fragments included, is printed as before, and development and test output is unchanged.
