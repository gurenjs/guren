---
"@guren/orm": patch
---

Keep transaction state with its database connection when the default connection changes. Route model updates and deletes through the same scoped write pipeline as query builders, with shared SQLite, PostgreSQL, and MySQL contract coverage.
