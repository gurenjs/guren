---
"@guren/cli": minor
---

`guren check` warns about route paths using `:name*`, which reads as a wildcard and is not one.

Hono takes everything between `:` and an optional `{constraint}` as the parameter name, with no special meaning for `*` — so `router.get('/files/:slug*', ...)` registers a single-segment parameter named literally `slug*`. `/files/a/b` 404s, and the controller's `req.param('slug')` is undefined. The syntax looks enough like a wildcard that the routing guide itself recommended it, so apps carry the mistake with nothing to tell them: the route registers, the app boots, and the only symptom is a 404 for every URL the author expected to match.

The check reads `routes/` and each module's routes files, including the single-file `modules/<name>/routes.ts` shape, and covers `get`/`post`/`put`/`patch`/`delete`/`query`, `on(method, path)`, and `group(prefix)` — a prefix carrying one spreads it over every route inside. Constrained parameters are left alone, including `:path{.+}`, `:path{.*}` and nested-brace constraints, as is Hono's real `*` wildcard segment. Each finding names the parameter Hono actually binds and prints the corrected path (`:slug{.+}`) to match across segments.

The finding is a plain `warn`, so a plain `guren check` still exits 0, but `check --ci` gates on it the way it does on an unmounted route registrar — both are routes that 404 with nothing else to report them. An app upgrading with a `:slug*` route already in it will go red there until the path is fixed.
