---
"@guren/cli": patch
---

Report the CLI version for `guren --version`

`guren --version` printed `ERROR  No version specified` and exited 1, behind a
full usage dump. The root command is built with citty, whose `--version`
handler reads `meta.version`, and the root command's `meta` only ever set
`name` and `description` — so the flag reported the absence of a version rather
than the version.

The root command now carries its own package version, read from the manifest at
startup rather than written into the source as a literal, which would drift at
every release:

```
$ guren --version
2.6.1
```

This is the obvious capability probe for tooling and AI agents that need to know
which Guren CLI an app has — whether `agent:init --target` is available, for
instance. citty ignores flags it does not recognise, so without a working
`--version` there was no cheap way to detect an older CLI: passing an
unsupported flag to it exits 0 and silently does something else.

An unreadable manifest leaves `meta.version` unset rather than throwing. The
root command module is evaluated for every command, so that failure costs only
`--version`, which falls back to the message above, and never `make:model`.
