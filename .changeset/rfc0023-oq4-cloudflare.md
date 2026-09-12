---
"@guren/plugin-cloudflare": patch
---

Bind the SSR renderer on the app instead of the deprecated process-wide setter

The generated `worker.js` used `setInertiaSsrRenderer(ssrModule.render)`, which
carries `@deprecated` as of RFC 0023. It now binds the renderer on the app it
already imported:

```js
if (!app.container.has('inertia.ssrRenderer')) {
  app.container.instance('inertia.ssrRenderer', ssrModule.render)
}
```

The `has()` guard keeps the precedence the setter had: an app that passed
`createApp({ inertia: { ssrRenderer } })` keeps its own renderer. Regenerate
with `guren cloudflare:build`; no app source changes.
