---
'@guren/server': minor
---

Stamp authorization capabilities on the authorize middlewares, so a route's
required ability is derivable from its middleware chain instead of from
controller bodies (RFC 0016 §4).

`authorizeMiddleware`, `authorizeAllMiddleware`, and
`authorizeResourceMiddleware` now carry an RFC 0007 capability stamp, which
`Router.definitions()` aggregates into `RouteDefinition.capabilities`
alongside the existing authentication capability. A single ability reports
`{ abilities: ['update'], mode: 'all' }`; an ability list reports `'any'`;
`authorizeAllMiddleware` reports `'all'`; the resource variant reports a
`resource` marker, whose `fromMethodMap` says whether the built-in HTTP verb
map decides the ability (it does not when an `abilityFor` callback overrides
it). A chain carrying several checks that do not combine into a single all-of
reports `mode: 'mixed'` — authorization is present, but no one ability may be
named for it.

The capability shape stays internal (nothing new is exported from the package
root) and may change in any release.
