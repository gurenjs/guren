---
"@guren/cli": minor
"create-guren-app": minor
---

Scaffold schemas from the dialect-specific `@guren/orm/drizzle/{pg,mysql,sqlite}` barrels

Follow-up to #379: generated `db/schema.ts` files now import every column
builder from the barrel matching the app's dialect, and `guren add auth` /
`guren add resource` merge new builders into that barrel instead of the mixed
`@guren/orm/drizzle` (PostgreSQL) or raw `drizzle-orm/*-core` (MySQL/SQLite)
specifiers. Apps scaffolded before the barrels keep working: builders already
in scope are left untouched, and only genuinely missing ones are imported via
the barrel, which requires `@guren/orm` >= 2.3.0.
