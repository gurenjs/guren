---
"create-guren-app": minor
---

Scaffolded apps now enable zod's compiled parsing: the app entry starts with `import 'zod/compile'`, so every schema built after it (validators, route contracts, output schemas) parses through a generated fast path. The template zod range moves to `^4.5.0` accordingly. The shim honors `z.config({ jitless: true })` for CSP-restricted runtimes and falls back to the regular parser for unsupported schemas; note that on invalid input, refinements and transforms can run twice, so keep them free of side effects.
