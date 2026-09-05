---
"create-guren-app": minor
---

New apps ship with oxlint and the Guren rules: an `.oxlintrc.json` loading `@guren/cli/oxlint` (`guren/await-async-assertion` as an error, the `guren/comment-*` rules as warnings), `lint` / `lint:fix` scripts, `oxlint` as a dev dependency on the range `@guren/cli` is tested against, and a Lint step in the scaffolded CI workflow. Apps created earlier get the same setup with `bunx guren add lint`.
