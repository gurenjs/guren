---
'create-guren-app': minor
---

The scaffolded CI workflow is one `bunx guren gate --deps` step

`.github/workflows/ci.yml` in the default and API-only templates ran codegen,
typecheck, lint, `check --ci`, `audit`, and the tests as six steps. It now runs
`bunx guren gate --deps`, the same stages in the same order, so a change that
passes `bunx guren gate` locally passes CI, and the API-only template no longer
needs `--routes routes/api.ts` (the gate finds the entry itself). Needs the
`@guren/cli` that ships `guren gate`.
