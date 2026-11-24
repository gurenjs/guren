---
'@guren/cli': minor
---

`guren plan:status` judges a planned route binding's lookup column (`bind: [{ param, model, key }]`) against the column the router looks the parameter up by, instead of always reporting it `unknown`. A binding with no `key` means `id`, `findOrFail()`'s default, on either side, so a route looking a parameter up by another column reads `differ`, and so does a bound model no lookup runs (an inline handler, a parameter the path does not declare). A custom resolver, a parameter bound both on the route and with `router.bind()`, a `router.bind()` a module sets used outside that module's routes, and a `@guren/core` without `Router.registeredBindingLookups()` keep it `unknown`, with the reason.
