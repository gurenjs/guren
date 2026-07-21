---
'@guren/cli': patch
---

Document a local-testing gotcha in the `plugin-authoring` agent skill (`agent:init`/`agent:sync`) and the plugin authoring guide: linking a plugin into a test app via `bun add file:`/`link:`/`workspace:` symlinks back to the plugin's source directory, so a plugin that still has its own `@guren/core` devDependency installed can end up loaded as two separate module copies alongside the app's — surfacing as duplicate-module runtime warnings or a `Property 'bindings' is protected...` TypeScript error. The fix (delete `node_modules` in the plugin package directory before linking) is now documented; published plugins never ship `node_modules`, so this only affects local testing before publishing.
