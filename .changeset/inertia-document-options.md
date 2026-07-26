---
'@guren/server': minor
---

Let apps configure the server-rendered Inertia document through `setInertiaDocument()`.

The `<body>` class and the critical CSS inlined into `<head>` were hardcoded to page components named `Docs/*`. Any other page whose theme is applied by a client effect painted the stylesheet's default surface color first and only corrected itself once React hydrated — a visible flash on the very first frame.

`setInertiaDocument({ bodyClass, criticalCss, prepaintScript })` moves that decision to the app. Each field takes a string or a function of the page component, so a docs section can claim a light surface while marketing pages keep a dark one. The same three fields exist on `InertiaOptions` for per-response overrides. Call it at module scope in the app entry so every runtime — the Bun server, serverless handlers, generated worker bundles — picks it up.

The old `Docs/*` special case is gone, but no scaffold or template ever emitted a page component under that name, so nothing needs migrating:

```typescript
setInertiaDocument({
  bodyClass: ({ component }) => (component.startsWith('Docs/') ? 'docs-theme' : undefined),
})
```
