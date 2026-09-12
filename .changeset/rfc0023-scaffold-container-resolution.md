---
"create-guren-app": minor
---

Scaffolded apps resolve services from the container

`src/app.ts` passes `createApp({ inertia: { document } })` instead of calling
`setInertiaDocument()` at module scope, and the blog blueprint's
`AuthorizationProvider` registers its policy with `this.container.make('gate')`
instead of `getGate()`. Both setters and the getter are deprecated as of server
2.23.0, so a freshly scaffolded app no longer warns at boot for code it did not
write. Output of `bunx guren upgrade`'s `container-only-service-resolution`
codemod, which migrates an existing app the same way. (RFC 0023)
