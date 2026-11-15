---
'@guren/cli': minor
---

Add `guren change:policy`, which keeps the generated block of `REVIEW.md` (RFC 0040): what `change:lane` always puts at `high`, the models with sensitive columns (and those the reader could not read), the routes that change data with their middleware, the sign-in they declare and what authorizes them, and the routes agents can call, read from the application as registered. Text outside the `guren:review` markers is the author's and is kept. An application it cannot read writes nothing and exits 1, and `--check` writes nothing and exits 1 while the block is stale or the file is missing. `guren add review` now writes `REVIEW.md` when there is none and the application loads, and never replaces one that exists. `change:lane` reads any edit to `REVIEW.md` as `high`, its generated block included, since the reviewer reads the whole file.
