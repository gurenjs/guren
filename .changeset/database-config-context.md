---
'@guren/orm': minor
'@guren/core': minor
---

A database connection can read the validated environment (RFC 0027 Part 1). `configureOrm(context?)` on the Postgres, MySQL, SQLite and AWS Data API factories accepts `{ env }`, and a function passed as `connectionString`, `filename`, `database`, `resourceArn` or `secretArn` receives it. The factory keeps the context it was given, so migrations, the admin client and error reporting resolve against the same env as the connection. When a handle opened earlier resolves to a different database under the new context, `configureOrm()` closes it and runs migrations again against the new one. Called without a context, as `guren db:migrate` and scripts do, the resolver receives `undefined` and falls back as before.

Every factory gains `hasMigrations()`, which reports whether the migrations folder holds a migration without touching the database (always `false` on D1, whose migrations wrangler applies).

`defineDatabaseConfig(database, { seedOnBoot })` from `@guren/core` puts `config/database.ts` into `createApp({ config })`: it binds `database`, and at boot calls `configureOrm({ env })`, then runs the seeders when `seedOnBoot` is set and `hasMigrations()` is true. Without an env schema it passes no context.

```ts
// config/database.ts
const database = createPostgresDatabase({
  migrationsFolder: new URL('../db/migrations', import.meta.url),
  connectionString: (context) => (context?.env ?? env.parse().values).DATABASE_URL,
})
export const { getDatabase, migrateDatabase, configureOrm, seedDatabase } = database
export default defineDatabaseConfig(database, { seedOnBoot: process.env.NODE_ENV !== 'production' })
```
