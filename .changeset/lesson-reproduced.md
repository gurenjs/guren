---
'@guren/cli': minor
---

`guren make:lesson --enforced-by <file>#<name>` writes the check that catches a lesson's failure, refused on what `check --docs` would fail, and with `--from <commit>` records whether it catches it (RFC 0040 §11): the test is laid over exports of the commit and its parent, and `reproduced` is `true` when the case titled `[<name>]` fails at the parent and passes at the commit, `false` when it passes at the parent, and `not-run` otherwise, with the reason in `reproducedBecause` (`--no-reproduce` skips the run). `--from` names the commit that removed the defect. The harness `fix` skill tags its reproducing test and passes the fix commit with that test.
