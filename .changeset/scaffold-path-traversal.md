---
"@guren/cli": patch
"@guren/server": patch
---

Reject path-traversal names in the `make:*` scaffolders

`make:test` and `make:view` accept a nested name (`make:view posts/Index`,
`make:test auth/Login`) and interpolated its segments straight into the output
path. `trimSlashes()` only strips the edges and `split('/').filter(Boolean)`
keeps `..` — it is non-empty — so a name like `../../../../tmp/evil` wrote
outside the project, and `--force` overwrote whatever was already there. The
name is not always something you typed: the MCP tool `guren_make_component`
declares it as an unvalidated request field, so an agent working from untrusted
content could reach it.

Nested names are now split with traversal rejected rather than stripped, and
every `make:*` scaffolder writes through a writer that asserts the resolved path
stays under the project root. `scaffoldFile()` (behind `make:controller`,
`make:model`, `make:route`, …) and the batch writer behind `make:feature`,
`make:auth`, and `make:module` had no containment check at all before this and
were safe only because `pascalCase()` happens to strip separators — the same
incidental safety `make:route` did not have.

Only traversal is rejected, so names the filesystem accepts still work:
`guren make:test "admin/my page"` and `guren make:view "顧客/Index"` behave
exactly as before. Codegen (`guren codegen --out`) is deliberately exempt, since
its output directory is yours to choose and may sit outside the project.

`secureCompare()` from `@guren/server/auth` is hardened in the same release.
`Buffer.from(value, 'hex')` stops decoding at the first invalid pair, so two
different strings that share an invalid prefix — `'zzzz'` and `'yyyy'`, or
`'abcz'` and `'abdz'` — decoded to identical buffers and compared **equal**. It
now rejects input whose hex decode does not round-trip to the original length.
If you called it with UUIDs, base64 tokens, or anything else that is not strict
hex, switch to `secureStringCompare()`, which is built for exactly that.
