---
"@guren/server": minor
---

Add the container seams RFC 0023 Part 0 names, without changing what any consumer reads

- `getRequestContainer(ctx)` / `tryGetRequestContainer(ctx)` read the container
  of the `Application` serving a request; the app stamps it under
  `CONTAINER_CONTEXT_KEY` as its first middleware.
- `defaultApplication()`, `defaultContainer()`, `useAsDefaultApplication(app)`
  and the test seam `resetDefaultApplication()` name the ambient slot the
  `Application` constructor already wrote through `setContainer()`. Constructing
  a second `Application` while one exists makes the next ambient call warn once.
- `Worker` accepts `{ container }` and hands it to each job through
  `Job.setContainer()` before `handle()`; `Job.make()` prefers it. `processJob()`
  takes the same option.
- `QueueManager.dispatch(JobClass, payload, options)` is the explicit form of
  `JobClass.dispatch()`, pushing through that manager's default driver.
- `createApp({ inertia: { document, ssrRenderer } })` binds `inertia.document`
  and `inertia.ssrRenderer` on the app's container; `Controller.inertia()` reads
  them ahead of `setInertiaDocument()` / `setInertiaSsrRenderer()`, which keep
  working as the process-wide fallback.
