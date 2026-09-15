---
'@guren/cli': minor
---

`guren codegen` registers each named route's parsed `params`, `query` and `body` types on `GurenRouteContracts` in `.guren/routes.gen.ts`, which types `Controller.validated('route.name')`. `make:feature` controllers read `this.validated()` in `store` and `update` instead of calling `validateBody()` against the schema the route already declares. `guren audit` passes a controller route whose server reports `validatesBody` as validated at route level, and keeps failing one on a server that does not enforce the schema.
