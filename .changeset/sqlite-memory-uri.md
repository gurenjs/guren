---
"@guren/orm": patch
---

`createSqliteDatabase()` opens `file::memory:` in memory on every platform. It used to hand the URI to `bun:sqlite` unchanged, and Bun's Linux build, whose sqlite does not read URI filenames, created a file named `file::memory:` in the working directory instead, so the database persisted between runs. The in-memory spellings are now `:memory:`, an empty filename, and `file::memory:` (a trailing `#fragment` is ignored).

`file::memory:?cache=shared` now throws the same "cannot honour the URI parameters" error as any other `file:` URI with a query. Shared cache can only be requested through a URI, which Bun reads on some platforms and not others, so the parameter cannot be honoured everywhere. Use `:memory:` instead.
