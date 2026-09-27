---
'@guren/orm': patch
---

`createSqliteDatabase()` now turns on foreign-key enforcement (`PRAGMA foreign_keys = ON`) for every connection it opens. SQLite leaves it off per connection, and only `resetDatabase()` used to enable it, so a test suite saw `onDelete: 'cascade'` work while the dev server and production ignored every `REFERENCES` clause.

What changes for a SQLite app:

- Deleting a parent row now cascades, sets null or restricts as the schema declares.
- Deleting a parent that children still reference, under the default `NO ACTION`, now fails with `FOREIGN KEY constraint failed` instead of leaving orphaned rows.
- Inserting a row whose foreign key names no parent now fails. A seeder that inserts children before their parents, or clears parent tables first, has to reorder, as it already does on Postgres and MySQL. So does a `useTruncateTables()` list run through the connection `getDatabase()` returns.
- Rows already orphaned in an existing database are not checked or removed. `PRAGMA foreign_key_check` lists them.

Migrations run with enforcement off and turn it back on afterwards. The migrator applies them inside one transaction, where a drizzle-kit table rebuild's own `PRAGMA foreign_keys=OFF` is ignored, so its `DROP TABLE` would otherwise cascade into the child tables. No foreign-key action fires during a migration either: a data migration that deletes parent rows leaves their children behind. When a run applies at least one migration, the factory then runs `PRAGMA foreign_key_check` and warns about any row left without its parent.
