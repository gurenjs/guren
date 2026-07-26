---
'@guren/orm': minor
'@guren/core': minor
'@guren/cli': patch
---

Add `createAwsDataApiDatabase()` for Aurora Serverless v2 via the RDS Data API.

The factory mirrors the other database factories (`getDatabase`, `migrateDatabase`,
`configureOrm`, `seedDatabase`, `resetDatabase`, `migrationStatus`) on top of
`drizzle-orm/aws-data-api/pg`. The Data API is HTTP-based, so Lambda apps get a
Postgres-compatible connection without a connection pool, RDS Proxy, or VPC
placement. Connection settings resolve from options or the `DATABASE_NAME`,
`DATABASE_RESOURCE_ARN`, and `DATABASE_SECRET_ARN` environment variables;
`@aws-sdk/client-rds-data` is an optional peer dependency. Unlike the other
factories, `getDatabase()` does not run pending migrations automatically —
on Lambda that check costs serialized Data API round trips on every cold
start. Run migrations out of band, or opt back in with `migrateOnStart: true`.
