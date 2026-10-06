---
"@guren/server": patch
---

Reject a signed token with segments after its signature. `MessageSigner.verify()` accepted `payload.signature..anything`, leaving the suffix unauthenticated, and the CSRF middleware reused a guest's `XSRF-TOKEN` cookie verbatim, so a cookie planted from a sibling subdomain could carry markup into `csrfField()`. `csrfField()` now also HTML-escapes the token.
