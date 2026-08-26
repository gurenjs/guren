---
"@guren/server": minor
"@guren/core": minor
---

First-class content rendering (RFC 0014): `Controller.view(component, props)`
renders a `hono/jsx` component to plain server-rendered HTML — the
non-hydrating counterpart to `this.inertia()` for public content pages, with
auto-escaping, native `<title>`/`<meta>`/`<link>` head hoisting, and a loud
error when a page forgets its Layout (pass `{ doctype: false }` for
intentional fragments).

Alongside it: `viteAsset(entry)` resolves Vite asset URLs (dev server in
development, hashed manifest output in production, throws when neither
resolves), and new `@guren/core/jsx-runtime` / `@guren/core/jsx-dev-runtime`
subpaths let View files compile with `/** @jsxImportSource @guren/core */` —
applications never declare hono themselves. `@guren/server`'s hono floor
moves to `^4.13.0`, where the component result contract `view()` renders was
introduced.
