---
"@guren/server": minor
"@guren/core": minor
---

`setInertiaDocument()` now warns

The scaffold templates pass `createApp({ inertia: { document } })`, which leaves
the setter with no caller the framework itself emits, so it joins the other
deprecated setters in warning once. It keeps working until 3.0.0, and the engine
still reads the slot behind the container binding.

Move a call of your own into the option:

```ts
const app = createApp({
  inertia: {
    document: {
      head: '<link rel="icon" type="image/svg+xml" href="/favicon.svg" />',
    },
  },
})
```

`bunx guren upgrade` rewrites an inline `setInertiaDocument({ … })` whose
`createApp()` is in the same file.
