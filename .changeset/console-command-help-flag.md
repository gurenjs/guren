---
'@guren/server': patch
---

`bun run console <command> --help` (or `-h`) now prints that command's help and exits 0 instead of running the command. The kernel only recognised `help`/`--help` as the first argument, so the flag after a command name reached the command's input parser, which ignores unknown options, and a command like `attachments:prune` ran for real. The flag is honoured anywhere among the arguments; a command whose signature declares `--help` or `-h` itself still receives it.
