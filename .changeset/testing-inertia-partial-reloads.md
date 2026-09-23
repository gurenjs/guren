---
'@guren/testing': minor
---

The controller mock resolves Inertia props through the runtime's own rule: a partial reload narrows the props to what the request's headers select, a deferred prop is announced under `deferredProps` on the initial visit and resolved on the follow-up, and a lazy (function) prop runs only when it is sent. `createGurenControllerModule().Controller.inertia()` now returns a promise, as the runtime's does; `InertiaPayload` gains the optional `deferredProps` field.
