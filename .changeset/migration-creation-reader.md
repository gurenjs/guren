---
'@guren/orm': minor
---

`@guren/orm/internal/migration-guard` exports `readCreationStatements()`, which reads a migration that does nothing but create tables, their indexes and their foreign keys in the statements drizzle-kit writes, and gives `undefined` for anything else, and `snapshotRecordsCreation()`, which holds a drizzle-kit snapshot to the previous one plus what those statements create. `guren change:lane` reads them to judge a migration an approved plan declares.
