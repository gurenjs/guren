---
"@guren/orm": patch
---

Stop keying a hot-reload database handle to a stack frame that names no file.

Under `bun --hot`, a handle built by `createPostgresDatabase()` and friends is
identified by the file that built it, read from frame 2 of a captured stack. But
JSC synthesizes frames for code nobody wrote and reports them with a location
like any other frame: a class carrying a field initializer, or a subclass that
declares no constructor of its own, appears as `at new Owner (unknown:1:17)`, and
a built-in doing the calling appears as `at map (native:1:11)`. Reading one of
those as the caller keyed every such handle in the process to the literal string
`unknown`, collapsing handles opened from unrelated files into one registry slot
where each new one closes the previous one's live connection.

`describeCallerFile()` now walks outwards from frame 2 to the first frame that
names a real file, skipping `unknown`, `native`, and `<anonymous>` — and still
returns nothing when every frame is synthetic, so the handle is left alone rather
than given a key that is wrong. Nothing in the framework hit this, because each
factory is a plain function called from module scope; `class Database { db =
createPostgresDatabase({ url }) }` in an application was enough to.

The walk also steps over host frames the engine leaves without a location at all,
which Bun emits for a callback a built-in invoked (`at replace (unknown)`). Those
previously stopped the read at frame 2 and produced no key, so such a handle was
never reclaimed across a reload; it now resolves to the file that opened it.

The equivalent registry for hot-reloaded timer owners already guarded this; the
ORM's registry now does too.
