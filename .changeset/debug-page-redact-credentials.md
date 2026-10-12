---
'@guren/server': patch
---

The development debug page now shows `[redacted]` in place of the values of the `Cookie`, `Authorization`, `Proxy-Authorization`, `X-XSRF-TOKEN` and `X-CSRF-Token` request headers. It printed them verbatim, which put HttpOnly session cookies where the page's script could read them. The other headers are shown as sent.
