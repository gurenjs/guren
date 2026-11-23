---
'@guren/cli': minor
---

The per-route security records (`guren change:records`, `change:lane`) now carry each binding's lookup column (`app/Models/Post.ts#Post@slug`) and a router-level custom resolver by a digest of its source, the routes files and the declarations its names reach (`resolver#<digest>`); a parameter bound at both levels carries the router's lookup too (`+router:`), so changing a route's lookup column or resolver is a `route-changed` fact. A plan's `bind` with a `key` can now be declared. On an `@guren/server` that does not report the columns, or for a native resolver such as a bound method, a record says `bindingLookups: 'unread'`: no binding is declared, and a change to a route file is held at `medium`. The records are version 4, so a stored base record of version 3 is not compared.
