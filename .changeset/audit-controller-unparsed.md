---
'@guren/cli': patch
---

`guren audit` now warns with `controller-unparsed:<file>` for a controller file it read but could not parse. Such a file never entered the class index, so its actions were judged against no body, and a route matched to one of its classes by name alone borrowed the body of another controller file declaring the same class name without any `controller-name-collision` finding. The finding carries the file but no line, so a `config/audit.ts` entry can ignore it. It has its own key rather than reusing `controller-unreadable`, because the fix differs (a syntax error, not a missing or unreadable file) and an ignore entry for one cause should not cover the other.
