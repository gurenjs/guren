---
"@guren/server": minor
"@guren/core": minor
"@guren/cli": minor
---

**Server-side prototype routes and `guren check --prototype` (RFC 0021 Part 2)** — `router.get('/posts', prototype).name('posts.index')` registers a route that answers from the app's fixture module (`createApp({ prototype: () => import('../resources/js/prototype/index.js') })`) until a controller replaces it. The route contract is enforced first, as for an inline handler; a `page()` result renders through the shared-props pipeline with the real resolvers winning over the fixture's, `redirect()` is a 303 to the named route, `errors()` takes the `ValidationException` path, `location()` is an Inertia location visit, and `notFound()` a 404. The boot validates every prototype route (named, answered by the fixture, a loader present) and refuses them in production unless `GUREN_PROTOTYPE_ROUTES=1`, since the fixture's state is shared by every request of the process. `RouteDefinition.prototype` marks them: `guren context` lists a prototype backlog, `guren doctor` reports them as a deploy blocker, agent derivation skips them with a warning, and `guren check --prototype` runs the wiring rules (fixture entries against the route graph, ambiguous paths, `.agent()` on a fixture-backed route, the `createApp()` loader), gating the build script.
