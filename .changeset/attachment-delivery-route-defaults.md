---
"@guren/core": minor
"@guren/cli": patch
---

Export `DEFAULT_DELIVERY_ROUTE_NAME` from `@guren/core`.

The delivery route's default name is a cross-package contract: `guren check`'s
attachments rules judge, from another package, whether the name the delivery
route registers under is claimed by more than one route. That rule kept its own
copy of `'attachments.show'`, which would not have failed loudly if the
framework's default moved — it would have stopped matching the route that was
actually registered and reported a genuine collision as fine. The check now
imports the constant instead of restating it.
