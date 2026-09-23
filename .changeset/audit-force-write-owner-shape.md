---
'@guren/cli': patch
---

`guren audit`'s force-write finding no longer tells you to keep every value derived from request input out of `forceCreate`/`forceUpdate`, which contradicted the tutorial's owner pattern. It now says what to confirm when a validated body is spread only to add a server-chosen column outside `fillable`: the schema declares only columns a request may set, and the server value comes after the spread. It also keeps the rule that a `MassAssignmentException` is never fixed by moving the same payload to a force write. The finding still fires on the same methods.
