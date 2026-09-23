---
'@guren/cli': patch
---

`guren codegen` reads a parenthesized object alias (`export type PostResourceData = ({ id: number })`) as the object type it is, instead of refusing it as "not a plain object type". A body composed after the parentheses (`({ … }) & Other`, `({ … })[]`) is still refused with the existing reason.
