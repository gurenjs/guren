---
'@guren/orm': patch
---

The destructive-migration guard now reads a migration the way drizzle's migrator runs it as well as the way the file reads. The migrator cuts the file at every `--> statement-breakpoint`, including one inside a comment or a string, and runs each piece on its own, so `-- x --> statement-breakpoint DROP TABLE "users";` drops a table the guard used to read as a comment. Findings from both readings count, at their lines in the file, for the boot guard, `guren db:migrate`, `guren check` and `guren change:lane`. On PostgreSQL a line comment now also ends at a bare carriage return, as the server ends it, so `-- x\rDROP TABLE "users";` is reported too.

A separator inside a comment or a string that only reads as harmless (`/* note --> statement-breakpoint */`) is now reported as `unreadable`, since the migrator runs the broken piece it leaves; under `destructiveMigrations: 'refuse'` that stops the boot until the separator is removed or the file carries the marker.
