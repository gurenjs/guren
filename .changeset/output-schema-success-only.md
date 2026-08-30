---
'@guren/server': patch
---

Validate a route's `output` schema against successful responses only. `output` states what the action *returns*, so a failure response is outside it by construction — the exception handler wrote that body, not the action. Validating it anyway rewrote every `validateBody()` rejection on such a route into `500 Response validation failed`, hiding the real 422 behind a report that the app had violated its own contract. RFC 0016 makes the combination usual rather than exotic, since `guren check` warns about an agent route with no `output` schema.

A 3xx response with a JSON body is no longer validated either, which was mostly latent already (a redirect's empty body tripped the parse guard and skipped validation). The agent surface is unaffected: `mapToolResponse` independently reports a 204 or 3xx from a tool advertising an object output schema as an error result.
