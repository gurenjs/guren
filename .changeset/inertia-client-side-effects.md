---
'@guren/inertia-client': patch
---

`@guren/inertia-client` declares `"sideEffects": false`, so a client bundle keeps only the modules a page uses. A page importing `useTranslation` or `ErrorBoundary` from the root entry used to pull in `renderInertiaServer` and with it both builds of `react-dom/server`, which cannot be tree-shaken. In `examples/blog` the client's `inertia-vendor` chunk drops from 529.06 kB to 341.63 kB (164.56 kB to 107.61 kB gzipped). No module in the package does anything at load: the input kept from before hydration is still recorded by `startInertiaClient()` when it hydrates.
