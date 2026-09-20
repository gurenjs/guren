---
'@guren/cli': patch
---

Tighten the acceptance-behaviour reader (RFC 0030 §6): `planAcceptanceIds()` returns distinct ids again, each behaviour of a case naming two ids gets its own record, an undeclared id is cut short before it reaches a display channel, and the XML subset reader takes every limit from its caller and raises a junit-vocabulary failure under its own error type.
