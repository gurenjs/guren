---
'@guren/cli': minor
---

The per-route security records (`guren change:records`, `change:lane`) now carry each binding's lookup column (`app/Models/Post.ts#Post@slug`) and a router-level custom resolver by a digest of its source (`resolver#<sha256>`), so changing a route's lookup column or resolver is a `route-changed` fact. A plan's `bind` with a `key` can now be declared. On an `@guren/server` that does not report the columns, a record says `bindingLookups: 'unread'` and no binding is declared. The records are version 4, so a stored base record of version 3 is not compared.
