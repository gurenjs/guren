---
"@guren/core": patch
---

fix: compute deploy-bundle import specifiers from real paths

`buildLambdaOutput({ outputDir })` failed with `Bundle failed` whenever the
output directory was reached through a symlink that changes path depth — on
macOS `/tmp` is a link to `/private/tmp` and `os.tmpdir()` lives under
`/var/folders`, a link into `/private/var`, so pointing a build script or CI
harness at a temp directory hit this immediately.

The generated `handler.ts` imports the app entrypoint through a relative
specifier, and `importSpecifier()` computed it from the paths as given while
the bundler resolves the emitted file from its real path. A depth-changing
link left the specifier one `..` short. Both arguments now resolve through
`realpathOfNearestExisting()` first — the same normalization the module's
deletion guard already applies.

The default `<root>/.lambda` output and the `lambda:build` command were never
affected; only programmatic calls passing an explicit `outputDir` were.
