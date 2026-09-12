---
"@guren/server": minor
"@guren/core": minor
---

Both Inertia setters now warn, and RFC 0023's Open Question 4 is settled

`document` stays the `createApp({ inertia })` option, and a renderer that only
exists after `createApp()` has run is bound on the app rather than pinned to the
process — which is what the Workers entry `@guren/plugin-cloudflare` generates
now does. With the scaffold templates on the option too, neither
`setInertiaDocument()` nor `setInertiaSsrRenderer()` has a caller the framework
itself emits, so both join the other deprecated setters in warning once. They
keep working until 3.0.0, and the engine still reads their slot behind the
container binding.

Pass the option where the value is available at construction:

```ts
const app = createApp({
  inertia: {
    document: { head: '<link rel="icon" type="image/svg+xml" href="/favicon.svg" />' },
    ssrRenderer,
  },
})
```

and bind the key where it is not:

```ts
app.container.instance('inertia.ssrRenderer', ssrModule.render)
```

`bunx guren upgrade` rewrites an inline `setInertiaDocument({ … })` whose
`createApp()` is in the same file.
