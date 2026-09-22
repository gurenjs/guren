---
'@guren/cli': patch
---

`guren plan:status` judges three cases the RFC 0030 Part 2 measurements found wrong. An added element whose every planned property has no reader (a resource's fields, a policy's abilities) and which has no mount point reads `unjudged` rather than `present`. A planned `params` / `query` / `body` validator that a readable action body does not validate with, and no route contract holds, is a `differ` that keeps the action at `present`, never `wired`. And an element none of whose planned properties matched is lifted to `verified` only while a verified step of its task ran behaviours that reach it, so a listener nothing registers no longer reads `verified` on behaviours that never touch it.
