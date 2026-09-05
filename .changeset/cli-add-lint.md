---
"@guren/cli": minor
---

Add `guren add lint`: writes an `.oxlintrc.json` that loads the Guren rules from `@guren/cli/oxlint` (`guren/await-async-assertion` as an error, the `guren/comment-*` rules as warnings), adds `lint` and `lint:fix` scripts, and pins `oxlint` as a dev dependency. `bunx oxlint` runs under Bun, so an app needs no Node install for it.
