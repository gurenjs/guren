---
"@guren/orm": patch
---

Stop `createSqliteDatabase()` creating a `file:/…` directory tree when the filename is a `file:` URI.

The sqlite driver `mkdir -p`s the database's parent directory before opening it, and it computed that directory with `dirname(resolve(dbPath))`. `resolve()` has no notion of a URI, so `file:///var/tmp/app.db` is taken as a *relative* name: the driver prepares `<cwd>/file:/var/tmp/`, while sqlite — which does parse the URI — opens `/var/tmp/app.db`. The database is correct and the tree is a leftover.

This is the same defect #438/#440 addressed for connection strings, on the other side of the guard they added. That one narrowed the rejection to the *intersection* — a scheme with an authority, `file:` excluded — precisely because `file:` is sqlite's own URI scheme and names a file rather than a server. The narrowing was right and is unchanged here. What it left standing is that a legal `file:` URI still has to be *parsed* before it can be used as a path, and one code path was still concatenating it.

**Why nothing caught it.** The stray tree is empty (sqlite writes the real file elsewhere) and untracked, so no build, typecheck, or test gate reads it — `bun run test:bun` was green while `packages/orm/src/sqlite.test.ts` deposited one `file:/var/folders/…/guren-sqlite-XXXXXX/` per run into the repository. `git status` says nothing; only `git clean -nd` reports it, as `Would remove file:/`.

**The rule.** A new `sqliteFilePath()` resolves the filename once, to the path sqlite will actually open, and both the mkdir and the hot-reload key read it. It follows sqlite's URI rules (https://sqlite.org/uri.html) rather than the WHATWG URL parser's, which matters in a way that is easy to get backwards: `new URL('file:local.db')` yields `/local.db`, an absolute path at the filesystem root, where sqlite resolves that URI against the cwd — so parsing these through `node:url` would have moved the mkdir from the wrong directory to a worse one. Query and fragment are stripped before percent-decoding, so an encoded `?` stays part of the filename. A URI sqlite itself rejects (an authority that is neither empty nor `localhost`) and the empty-filename forms resolve to no path at all: nothing is created, and `new Database()` raises its own error.

**The hot-reload key is fixed with it,** because it read `resolve(dbPath)` too. Under `bun --hot`, `file:///data/app.db` and `/data/app.db` are one database but keyed as two, so a reload that merely restyled the filename would leave the first handle open instead of replacing it.

Every rule here was verified against bun:sqlite rather than inferred — each URI form was opened directly to confirm where the file lands, and the ones the rule turns on are pinned by tests: an absolute path, a relative one, `localhost` as the authority, and a percent-encoded directory segment.

Five regression tests, each shown to fail against the implementation it guards. `should create the directory the URI names, not one named after the URI` targets a directory that does not exist yet and asserts both halves — the database file was created *and* no `file:` tree was — so it goes red both for the concatenating version and for the tempting shortcut of skipping the mkdir whenever the filename is a URI. The pre-existing `file://` and `file:local.db` cases gain the absence and location assertions they were missing; they passed before this change while the tree was being created beside them. Two more cover the branches the rule adds: a `%20` in a *directory* segment, where skipping the decode prepares `deep%20dir` and sqlite then opens into a directory nobody created, and `file://localhost/…`, the one non-empty authority sqlite accepts. And a hot-reload case asserts that switching a filename to its own `file:` URI replaces the handle rather than orphaning it.

Scope: `createSqliteDatabase()` is the only driver that prepares a directory from the filename — `d1.ts` opens through a binding and creates nothing — and the two sites named above are the only ones that read the filename as a path.
