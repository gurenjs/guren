---
'@guren/server': patch
---

Anchor the asset path containment checks on a separator

The dev transpiler route, the Inertia client route, and the production Inertia
client handler resolved a request path and then checked containment with a bare
`startsWith(dir)`. A sibling directory whose name extends the base passes that —
`resources/js` against `resources/jsonfixtures`. All three now use
`startsWith(dir + sep)`, matching the check `public-assets.ts` already carried
for the same reason.

The check is reachable because the request remainder is taken with
`ctx.req.path.slice(base.length)`, so a doubled slash (`/vendor//var/...`) leaves
an absolute remainder that `resolve()` returns verbatim; `../` and `%2e%2e` are
normalized away by URL parsing before the handler runs. No default-scaffolded app
has a sibling directory that would escape, so this closes the check rather than a
live hole.
