---
"@guren/server": minor
---

A route `params` schema failure is now 422 on both handler kinds. It used to depend on how the route was handled: a controller action reported 422, while a functional typed handler given the identical schema and request reported 400.

422 is the framework's validation status. `ValidationException` is 422, the `validateBody` / `validateQuery` / `validateParams` helpers the guides document throw it — including the guides' explicit "422 on invalid params" — and the `query` and `body` halves of these same contract options were already 422 on both paths. Only `params` was spelled 400, and only the functional path ever put that number on the wire; the controller path built a 400 response and discarded it to throw `ValidationException` instead. The status is what clients branch on: `InertiaServiceProvider` renders `ValidationException` into `form.errors`, and a 400 skips that entirely, so a form posting to a functional handler saw its params errors silently dropped.

This ships as a minor rather than a major deliberately. The affected surface is narrow — functional typed handlers that declare a `params` schema — and the change moves behavior toward what the documentation already promises rather than away from it, so code written against the documented contract keeps working and code written against the old number was reading an inconsistency. Update any client or test asserting 400 on a params failure to expect 422.

The response body still differs in shape between the two paths: a controller action returns `{ message, errors: { field: [...] } }` and a functional handler `{ errors: { field: "..." } }`. That difference is not specific to `params` — it already applies to `query` and `body` — and is unchanged here.
