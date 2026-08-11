---
'@guren/cli': patch
---

Wake the screens spec drift gate for module files under `--changed`

`guren check --spec --changed` decides which spec views to regenerate by
matching changed paths against each view's source patterns. The screens view
listed only `modules/*/routes.ts` and `modules/*/index.ts`, but the route
graph is a runtime import: `loadRouteDefinitions` evaluates
`modules/<name>/index.ts` and everything the module registrar reaches from
there — files under `modules/<name>/routes/` (where `make:route --module`
writes), a prefix constant, or any other module file. A change touching only
such a file reported `screens.md` as fresh while it was stale, and `--spec`
sets the exit code, so CI waved the drift through. The screens view's module
source now matches the whole `modules/<name>/` tree; over-selection only
costs a regeneration, and the modules view already matched any source file
for the same reason.
