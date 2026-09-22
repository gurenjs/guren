---
'@guren/cli': patch
---

`guren plan:status` judges three cases the RFC 0030 Part 2 measurements found wrong. An added element whose every planned property has no reader (a resource's fields, a policy's abilities) and which has no mount point reads `unjudged` rather than `present`. A planned `params` / `query` / `body` validator that a readable action body does not validate with, and no route contract holds, is a `differ` that keeps the action at `present`, never `wired`. And an element none of whose planned properties matched is lifted to `verified` only while a verified behaviour reaches it through the plan's references, so a listener nothing registers no longer reads `verified` on behaviours that never touch it.

A plan with side effects or commands, or with another element that plans no property and that no behaviour reaches, now needs a waiver or a behaviour that reaches it before `guren plan:close` accepts it. A validate call on a chained or built schema (`this.validateBody(PostSchema.partial())`, `this.validateBody(z.object(...))`) names no exported validator, so it reads as a `differ` too. `plan:close` prints what holds each element it refuses, and `plan:next`, once every step is verified, reads the application with detail once to list the elements `plan:close` would still refuse.

An element no verified behaviour reaches now reports that missing behaviour and stays `present`, even when one of its files changed since, where it used to read `drifted`.
