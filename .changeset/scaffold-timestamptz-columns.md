---
"create-guren-app": minor
"@guren/cli": minor
---

Scaffold Postgres timestamp columns as `timestamptz`

Every timestamp a Guren scaffold emitted for Postgres was `timestamp without
time zone`: `add resource`'s `date` fields, the `createdAt` it appends, the
`createdAt`/`updatedAt`/`emailVerifiedAt` on `make:auth`'s users table, and the
`users` table `create-guren-app --db postgres` writes. All of them hold an
instant, so all of them are now `timestamp(name, { withTimezone: true })`.

A column without a time zone stores a bare wall clock, and who reads it decides
what that clock meant:

- `defaultNow()` records the wall clock of the **database session's** time zone,
  while the app reads the column back as if it were UTC. Whenever the database
  session is not on UTC, a `createdAt` is silently off by that offset — the
  wrong instant is written, not merely displayed.
- Values the app writes itself are UTC wall clock, so anything that is not
  Drizzle — `psql`, a raw `postgres` query, a report, another service — reads
  them as local time and sees a different instant.

Drizzle parses the offset-less column as UTC, so an app that only ever reads
through its own models stays self-consistent; `timestamptz` is what makes the
column mean the same instant to everyone else.

This changes generated code only — existing schemas are untouched. To adopt it
in an app that has already migrated, change the column in `db/schema.ts` and
generate a migration, then fix up the `USING` clause. Drizzle emits a bare
`::timestamp with time zone` cast, which reinterprets stored values against
whatever the session's time zone happens to be; name the zone the values were
actually written in instead:

```sql
ALTER TABLE "posts"
  ALTER COLUMN "published_at" SET DATA TYPE timestamp with time zone
  USING "published_at" AT TIME ZONE 'UTC';
```

`'UTC'` is right for values the app wrote. If the column also carries
`defaultNow()` rows, they were written in the database session's zone — check
it with `SHOW TimeZone` before converting, and split the conversion if the two
sets of rows disagree.
