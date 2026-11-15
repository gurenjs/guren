---
'@guren/cli': minor
---

Add `guren change:policy`, which keeps the generated block of `REVIEW.md` (RFC 0040): what `change:lane` always puts at `high`, the models with sensitive columns, the routes that change data with their middleware and the policies their action names, and the routes agents can call, read from the application as registered. Text outside the `guren:review` markers is the author's and is kept, and `--check` writes nothing and exits 1 while the block is stale or the file is missing. `guren add review` now writes `REVIEW.md` when there is none and never replaces one that exists. `change:lane` reads an edit to `REVIEW.md` outside its block as `high`, since it changes what a reviewer checks, and one inside it as `medium`.
