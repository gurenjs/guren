---
'@guren/cli': patch
---

`guren add storage` (and `guren add attachments`, which runs it) now roots the `local` disk at `./storage/app/testing` when `NODE_ENV=test`. Tests that uploaded files used to write them into the development disk at `./storage/app`, where they matched no row in the development database. An app scaffolded earlier can give its `local` root the same `process.env.NODE_ENV === 'test' ? './storage/app/testing' : './storage/app'` branch, then run `attachments:prune --objects` once to remove the leftovers.

`guren check`'s "Attachments disk outside public/" rule reads a `root` written as a conditional of string literals and fails the disk when any branch sits inside `public/`. It used to skip such a disk without reporting anything.
