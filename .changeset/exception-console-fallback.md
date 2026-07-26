---
'@guren/server': patch
---

Report unhandled exceptions to the console when no reporter is registered.

An app that never called `reporter()` turned a 500 into a rendered error page and nothing else. On a hosted runtime, where stdout is the only channel back to the operator, that left production failures with no trace to follow — the cause could only be found by bisecting the code. Anything that registers a reporter still owns reporting entirely; this only fills the empty case.
