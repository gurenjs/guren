---
'@guren/cli': patch
---

Guren is now tested on Bun 1.4.2 as its primary runtime; Bun 1.3.14 keeps a non-blocking CI lane. `guren doctor`'s Bun check and `guren upgrade`'s compatibility warning now judge against the oldest line CI still runs (1.3), not against 1.1.0 and 1.0.0: Bun 1.0 to 1.2 reads as a warning ("tested on Bun >= 1.3.0 only"), so `guren doctor --strict` exits non-zero there.
