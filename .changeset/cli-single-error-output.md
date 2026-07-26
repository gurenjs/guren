---
'@guren/cli': patch
---

A failing `guren` command now reports its error once instead of twice.

citty's `runMain()` logs a thrown error twice — once with its stack, once as a
bare message — and then exits the process itself, so the CLI's own error
handler never ran. The root command is now wired through a local wrapper that
keeps `--help`, `-h`, `--version`, unknown-command usage, and plugin
subcommand proxying intact while owning the error path.
