---
'@guren/server': minor
---

Partial reloads and deferred props for Inertia responses. A request whose `X-Inertia-Partial-Component` names the rendered component is answered with the props its `X-Inertia-Partial-Data` and `X-Inertia-Partial-Except` headers select (shared props included), and a prop passed as a function is called only when it is sent. `always(value)` marks a prop sent on every response whatever those headers say; the flashed `errors` prop is shared that way. `defer(() => value, group?)` keeps a prop out of the initial response, announces it under the page object's `deferredProps` by group, and resolves it on the partial reload the client sends for that group. `Controller.inertia()` accepts a deferred or lazy prop wherever the page declares its resolved type, and `ControllerInertiaProps` reads the resolved type back. The response marker carries the props the response sent, so on a 409 version mismatch (which sends none) it is empty.
