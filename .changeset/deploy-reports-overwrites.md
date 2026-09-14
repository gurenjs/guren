---
'@guren/cli': patch
---

`guren deploy --force` prints "Overwrote" for a recipe that already existed (a `Dockerfile` from an earlier run, say) and "Created" only for the files it wrote fresh. It used to report every file as created.
