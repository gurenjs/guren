---
'@guren/orm': patch
---

The SQLite driver no longer quotes a rejected connection URI in the error it throws. A `DATABASE_URL` naming another driver (`postgres://user:secret@host/db`) used to appear whole in the boot and migration error, password included; the message now names only the URI's scheme and where it came from.
