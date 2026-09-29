---
"@guren/cli": minor
---

`guren graph` and `guren_get_application_graph` now fill the middleware, validator, policy and test sections. `usesMiddleware` comes from each registered route's resolved chain, `validates` from controller validate calls and route contract schemas matched to validator exports, `authorizes` from policy classes an action imports, and `tests` from `TestApp` requests. What a reader cannot establish (inline middleware, gate calls bound at boot, schemas outside validator files, unresolvable test requests) is listed as unresolved with partial coverage. With `--no-introspect`, `handles` and `binds` are now `unavailable` like the other route-only sections instead of `partial`. The introspection child now learns it is a graph run from `GUREN_INTROSPECT_GRAPH=1` rather than a positional argument.
