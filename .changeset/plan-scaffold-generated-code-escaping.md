---
'@guren/cli': patch
---

`plan:scaffold` writes generated code that a plan's names cannot break out of: a foreign key to a column whose name is no identifier is written as a quoted property access, and a page or column name holding a line terminator (including U+2028 and U+2029) stays inside the controller comment that names it.
