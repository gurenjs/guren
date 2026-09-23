---
'@guren/core': patch
---

The Lambda and Vercel deploy builds stub `mysql2/promise` with only `createPool` (the name drizzle imports) when the app declares a different dialect. Application code importing any other name (`createConnection`, `escape`, a `Connection` type, …) failed `bun build` with "No matching export in \"guren-lambda-stub:mysql2/promise\"" — the exact failure the stub exists to prevent. `SQL_CLIENT_MODULES` in `@guren/core/internal/deploy-build` now stubs the module's whole public API.
