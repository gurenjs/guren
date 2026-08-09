---
'@guren/server': patch
---

Make translation interpolation literal-safe

`Translator.applyReplacements` built its `:key`/`{key}` patterns from the
raw replacement key and passed the value straight to `String#replace`, so a
key containing regex metacharacters could throw or match the wrong text,
and a value containing `$` sequences (e.g. user input with `$&`) was
expanded instead of inserted literally. Keys are now regex-escaped and
values replaced via a callback, keeping both fully literal.
