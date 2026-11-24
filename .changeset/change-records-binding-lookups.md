---
'@guren/cli': minor
---

The per-route security records (`guren change:records`, `change:lane`) now carry each binding's lookup column (`app/Models/Post.ts#Post@slug`) and, for a parameter bound at both levels, the router's model and column too (`+router:`), so changing a route's lookup column or the model it binds is a `route-changed` fact. A plan's `bind` with a `key` can now be declared. A custom resolver (`router.bind('token', fn)`), whose body is not read, and an `@guren/server` that does not report the columns make a record say `bindingLookups: 'unread'`: no binding is declared, and any change the records are read for is held at `medium` with the routes named, since a resolver's body may sit in any file. Upgrade `@guren/core` with `@guren/cli` so its routes are read. The records are version 4, so a stored base record of version 3 is not compared.
