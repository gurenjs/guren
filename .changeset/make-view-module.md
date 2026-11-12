---
'@guren/cli': patch
---

`guren make:view <path> --module <name>` now writes the page to `resources/js/pages/<name>/<path>.tsx`, where `make:feature --module` puts a module's pages and `make:controller --module` looks for them. The flag was accepted and ignored, so the page landed at `resources/js/pages/<path>.tsx`. The next step `make:controller --module` prints names the command with the flag.
