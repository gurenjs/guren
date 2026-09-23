---
'@guren/cli': patch
---

`guren plan:status` reads a policy's planned abilities (`match` when the class declares the member, `differ` when it does not, `unknown` where the class may hold it unread) and judges a side effect `wired` when the application's source dispatches, registers or sends it. Mail and notification classes are discovered (`app/Mail`, `app/Notifications`) instead of reading `unjudged`. A side effect now completes at `wired`, so `plan:verify` reports its step `incomplete` while nothing uses the class; it still closes only on a behaviour or a waiver, and so does a policy whose abilities match only by name.
