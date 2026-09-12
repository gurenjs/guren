---
"@guren/server": minor
"@guren/core": minor
---

### Deprecated

- **Module-level service setters and getters** — `setGate`/`getGate`, `setEncrypter`/`getEncrypter`, `setMailManager`/`getMailManager`, `setQueueDriver`/`getQueueDriver`, `setI18n`/`getI18n`/`tryGetI18n`, `setLogManager`/`getLogManager`, `setNotificationManager`/`getNotificationManager`, `setBroadcastManager`/`getBroadcastManager`, `setExceptionHandler`/`getExceptionHandler`, `setContainer`/`getContainer`, `setInertiaDocument`, `setInertiaSsrRenderer`, `setInertiaSharedProps`/`getInertiaSharedPropsResolver`, and the `SendNotificationJob.notificationManager` static. Resolve services from the container of the application that owns the call instead. Deprecated in 2.23.0, will be removed in 3.0.0. Detected by `bunx guren upgrade --check-only` as `global-service-setters` and `global-service-getters`; codemod available: run `bunx guren upgrade`. (RFC 0023 Part 2)

Nothing is removed and every call still works. Each accessor now carries
`@deprecated` JSDoc naming its replacement and warns once per symbol in the
format `contributing/deprecation-policy.md` defines.

**A setter now writes the live application's container.** Part 1 made every
consumer read the container first and the module slot second, which left a
hand-written `setMailManager(m)` silently shadowed by the binding a provider
had already made. The shim binds the key on the ambient container instead, and
clears its own slot so no value outlives the app that received it. Two
applications in one process therefore no longer inherit each other's
hand-installed services. Where no `Application` has been constructed yet — both
scaffold templates call `setInertiaDocument()` at module scope above
`createApp()` — the slot is still where the value lands, and the getters keep
reading it second.

`setInertiaDocument` and `setInertiaSsrRenderer` are tagged and reported but do
not warn at runtime. RFC 0023 Open Question 4 has not settled whether
`createApp({ inertia })` or the setter is the endpoint, the Workers entry
`@guren/plugin-cloudflare` generates still calls `setInertiaSsrRenderer()`, and
both scaffold templates still write `setInertiaDocument()`; a warning naming
code the framework itself emits is not something an app author can act on. The
codemod rewrites both for an app that wants to move now.

`setQueueDriver()` keeps its override: through this release the pin still wins
over the bound `queue` manager, because `@guren/testing`'s `fakeQueue()` and the
tutorial's queue chapter inject through it and nothing else expresses that. The
pin goes with the setter in Part 3.

The functional helpers are not deprecated and do not warn: `encrypt`, `decrypt`,
`t`, `tc`, `can`, `cannot`, `defineGate`, `authorizeAbility`, `resolve`,
`Job.dispatch` and `Job.make` resolve through internal seams, so an app that
never calls an accessor by hand sees no warning at all.

One new export, `@internal`: `resolveQueueDriver()` is `getQueueDriver()`
without the warning, for the framework's own dispatch paths in `@guren/core` and
`@guren/cli`.

These symbols are re-exported from `@guren/core`, which makes them Stable under
`contributing/api-stability.md`, so the policy's minimum of two minor versions
applies before removal. Deprecated in 2.23.0, that permits removal from 2.25.0
onward; `removedIn` targets 3.0.0.
