---
'@guren/cli': patch
---

`guren make:controller` names the page its scaffolded `index()` renders and the `make:view` command that writes it, while no file provides that page. The generated controller refers to `pages.<name>.Index`, so the app did not typecheck until the page existed, and nothing said so. The path is the one codegen keys the page by: `userProfile/Index` for `make:controller user-profile`, and `billing/invoice/Index` for a controller in the `billing` module, which `make:view --module` does not write.
