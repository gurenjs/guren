---
"@guren/cli": minor
"create-guren-app": minor
---

**Prototype-first scaffolding (RFC 0021 Part 3)** — `guren add prototype` installs prototype mode into an app: the fixture module (`resources/js/prototype/index.ts`, with a `paginate()` helper and a demo author in `shared.auth`), the `dev:prototype` / `build:prototype` scripts, the `startInertiaClient({ prototype })` and `createApp({ prototype })` wiring, and the `GUREN_PROTOTYPE` env declaration; idempotent, and `--remove` reverses the wiring and scripts while keeping the fixture. `create-guren-app --prototype` runs it after install. `guren make:feature <Entity> --fields … --prototype` scaffolds pages, the validator, a page-data type (`resources/js/types/<Entity>.ts`) and seven fixture entries with seed data, and prints the route registrations with the `prototype` handler; no model, migration, Resource or controller. Running `make:feature` again without the flag promotes the feature: the Resource is typed against that page-data type, the pages and validator are kept as edited, and the handler replacements are printed. The `prototype-pages-unreachable` check result is advisory, so a gate does not fail on walkthrough coverage.
