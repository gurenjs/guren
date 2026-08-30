---
'@guren/server': patch
---

Validate a route's `output` schema against successful responses only. `output` states what the action *returns*, so a failure response is outside it by construction — the exception handler wrote that body, not the action. Validating it anyway rewrote every `validateBody()` rejection on such a route into `500 Response validation failed`, hiding the real 422 behind a report that the app had violated its own contract. RFC 0016 makes the combination usual rather than exotic, since `guren check` warns about an agent route with no `output` schema.
