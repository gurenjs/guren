---
'@guren/core': patch
---

The Lambda and Vercel builds' renamed-class warning (`reportRenamedNameKeyedClasses`) also covers models. When another module declares the same top-level name, Bun bundles the model as `<Name>2`, and attachments and `morphMany` then store that name while `Model.morphMap` resolves the source name, so the two stop matching within one deploy. An app model named `Channel` can hit this, since `@guren/server` declares a top-level `Channel` for broadcasting. A model has no name to pin, so the warning asks for a new class name. The warning now also names only the declaration the numbered class extends from, so a dependency's renamed class is not reported as the app's.
