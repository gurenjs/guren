---
'@guren/server': minor
---

Skip CSRF verification for `Authorization: Bearer` requests that carry no `Cookie` header (RFC 0016). CSRF defends cookie ambient authority, and a cookie-less bearer request has none to attach — the token is the client's own deliberately presented credential. A request carrying any cookie verifies exactly as before, so a forged Bearer header on a victim-browser request skips nothing, regardless of middleware mount order. Token issuance is unchanged.
