---
"@guren/server": minor
"@guren/cli": minor
"@guren/core": patch
"@guren/orm": patch
"@guren/testing": patch
"@guren/openapi": patch
"@guren/inertia-client": patch
"create-guren-app": patch
---

Secure-by-default hardening and AI-agent tooling:

- `guren audit` command: validates auth/validation coverage on mutating routes, detects raw SQL, secrets, and mass assignment risks
- `make:feature` now scaffolds auth checks by default (`--public` to opt out) and supports `--policy`
- Authorization gate wiring, hardened auth/storage/mail/error rendering
- Inertia asset version mismatch handling
- drizzle-orm / drizzle-kit upgraded to 1.0.0-rc.1
- Migration tracker SQL escaping fix and dependency vulnerability patches
