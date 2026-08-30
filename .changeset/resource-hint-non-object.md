---
'@guren/server': patch
---

Stop `Router.definitions()` from recursing forever on a route `resource` hint
that is neither a Resource class, a single-element array, nor a plain object.

The hint is purely declarative and nothing validates it at runtime, so a value
outside `ResourceResponseHint` reaches the serializer. A string recursed until
the stack overflowed (every character is itself a one-character string), `null`
threw out of `Object.entries`, and a class instance serialized to `{}` — a
response shape the server never sends. All three now void the whole hint, the
same all-or-nothing rule an unnamed Resource class already followed.
