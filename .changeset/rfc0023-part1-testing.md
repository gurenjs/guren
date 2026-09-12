---
"@guren/testing": patch
---

`TestApp.create()` claims its application as the ambient one (RFC 0023 §3).
Without that, the second `TestApp` of a run read as a rival live application
and the next ambient helper in the suite under test warned about an ambiguous
default, though only one app was ever under test.
