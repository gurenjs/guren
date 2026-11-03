---
'@guren/server': patch
---

`requireAuthenticated()` and `requireGuest()` without `redirectTo` answer a browser navigation with a 401 or 403 error page instead of raw JSON, the way a CSRF refusal does. JSON, XHR, Inertia and agent tool callers keep the JSON body.
