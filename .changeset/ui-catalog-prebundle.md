---
'@guren/cli': patch
---

The Dev Center's component catalog no longer reloads, or throws `Invalid hook call` in Field, the first time it opens on a fresh Vite cache. `routeTypesPlugin()` now adds to `optimizeDeps.include` the packages the preview's entry and client import (`react`, `react-dom/client`, `@inertiajs/react`) and every package the copies under `resources/js/components/ui/` import at startup (Field's `@guren/inertia-client/forms`, or whatever an edited copy adds). Before, Vite crawled only the app's entry, found the preview's packages while serving it, and re-bundled and reloaded on each; a copy loaded in between could take React from the newer bundle while the renderer held the older one. `optimizeDeps.entries` is left alone, so Vite still crawls the app's entry.
