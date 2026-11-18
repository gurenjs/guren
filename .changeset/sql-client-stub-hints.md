---
'@guren/core': minor
'@guren/plugin-lambda': patch
'@guren/plugin-vercel': patch
---

The Lambda and Vercel builds no longer fail on `import { createConnection } from 'mysql2'` in an app that declares another database: the stub for the root `mysql2` entry now declares that module's whole export surface, as the `mysql2/promise` one already did. When a bundle still fails on a name a database client's stub does not list, the build adds a line naming the dialects it detected and the `databaseDialects` value (`--database` for `lambda:build`) that keeps the real client. The message a stub throws now names every dialect to declare, not the missing one alone.
