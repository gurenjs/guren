---
"@guren/server": minor
"@guren/core": minor
---

`setInertiaSsrRenderer()` now warns, and the generated Workers entry binds instead

RFC 0023's Open Question 4 is settled: `document` stays the
`createApp({ inertia })` option, and a renderer that only exists after
`createApp()` has run is bound on the app rather than pinned to the process.
The Workers entry `@guren/plugin-cloudflare` generates does exactly that, which
leaves the setter with no caller the framework emits, so it joins the other
deprecated setters in warning once.

Apps that call it themselves keep working until 3.0.0. Pass the option where the
renderer is available at construction:

```ts
const app = createApp({ inertia: { ssrRenderer } })
```

and bind the key where it is not:

```ts
app.container.instance('inertia.ssrRenderer', ssrModule.render)
```

`setInertiaDocument()` stays silent for now — both scaffold templates still call
it, and it warns once they move to `createApp({ inertia: { document } })`.
