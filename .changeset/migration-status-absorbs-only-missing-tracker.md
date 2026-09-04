---
'@guren/orm': patch
---

`migrationStatus()` on Postgres, MySQL, and SQLite now reports only a missing
tracker table as "nothing applied".

The catch around the `__drizzle_migrations` read absorbed every failure that was
not a connection failure, so a denied `SELECT`, a tracker whose columns drifted,
or a broken `drizzle` schema came back from `guren db:status` as every migration
pending — the answer that invites re-running migrations that were applied. The
three drivers now match the AWS Data API driver: only the undefined-table error
(SQLSTATE `42P01`, `ER_NO_SUCH_TABLE` 1146, SQLite `no such table`) is absorbed,
read off the driver error beneath drizzle's wrapper, and everything else surfaces
with its own message.
