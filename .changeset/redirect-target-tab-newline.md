---
'@guren/server': patch
---

`createRedirectSafetyMiddleware()` and `sanitizeOAuthRedirect()` reject a redirect target that hides `//` behind an ASCII tab or newline, such as `/%09/evil.example`. Browsers remove those characters when they parse `Location`, so the value used to pass as an app-relative path and send the user off-site. The OAuth `redirectTo` a scaffolded `make:auth` controller forwards from the query string was reachable this way.
