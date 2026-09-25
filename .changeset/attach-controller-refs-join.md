---
'@guren/cli': patch
---

`guren context <Entity>` now attaches the introspected app's controller references through the same route join `codegen --introspect` uses: method, path, route name and action, with a key both sides repeat equally paired in order. Two routes sharing a method, path and action are told apart by their names instead of both falling back to the class name.
