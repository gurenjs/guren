---
"@guren/plugin-cloudflare": patch
---

fix: the generated Workers entry names the SSR export the bundle actually has

`cloudflare:build` emitted `setInertiaSsrRenderer(ssrModule.render ?? ssrModule.default)`,
probing both renderer shapes. Since a built SSR chunk only ever has one of them,
esbuild reported the other as missing on every `wrangler deploy`:

```
▲ [WARNING] Import "render" will always be undefined because there is no matching
  export in ".guren/ssr/ssr-XXXX.js" [import-is-undefined]
```

The runtime fallback made it harmless, but it sat on the one line whose real
failure mode is Inertia silently falling back to CSR — so the warning that
means "your SSR is wired wrong" was printed on every healthy deploy too, and
could not be told apart from the genuine one.

`resolveSsrImport` already imports the built chunk to check it exposes a
renderer, so it now records which export won and the generated entry names that
one directly. Both shapes stay supported: a chunk built from
`export default` gets `ssrModule.default`, one from `export function render`
gets `ssrModule.render`.

The same check now tests each candidate for being a function rather than taking
the first non-nullish one, matching how the runtime loader picks a renderer — an
entry exporting `const render = 42` alongside a valid default builds instead of
failing.
