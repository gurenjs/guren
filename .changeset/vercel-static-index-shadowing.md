---
"@guren/core": patch
"@guren/plugin-vercel": patch
---

Stop the Vercel build from shipping the dev `index.html` shell.

The shell exists so Vite can serve the app in development, and the generated
`config.json` runs `{ handle: "filesystem" }` ahead of the catch-all to the
function — so a staged `index.html` answered `/` from the CDN and the app's own
root route never ran. Cloudflare and Lambda already dropped it, through the
shared `stageStaticAssets`; this build stages `public/` itself, having no
`/public/assets` mirror to build (its `config.json` carries a
`/public/(.*)` rewrite instead), and so never applied the rule.

The removal moves into `removeShadowingIndex` in `@guren/core`'s internal
deploy-build helpers, which `stageStaticAssets` now calls too. The rule is
stated once, for the platform whose layout differs as much as for the two that
share the staging function — the alternative, a second `rmSync` in the plugin
with a comment pointing back here, is how the two copies drift. The cost is
that this ships as a two-package release rather than a one-line plugin patch.
