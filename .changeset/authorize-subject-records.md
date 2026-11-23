---
'@guren/cli': minor
---

Each route's security record (`guren change:records`) now resolves the class an `authorize()` or `can()` call asks about to the file and export its import names, and marks an `authorize()` call `unconditional` when the action awaits it as a statement of its own body with no statement before it that may return. `guren change:lane` therefore reads a subject class of the same name from another file as an incomparable change, and an `authorize()` moved under a condition, after a statement that may return, into a `try`, behind `void` or `.catch()`, or into a helper as `authorization-removed`, where both read as unchanged before. A declared route now needs the unconditional mark too. The records move to version 3, so a base record stored by an earlier version is not compared, and `change:lane` names the run to repeat.
