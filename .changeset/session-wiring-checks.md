---
'@guren/cli': minor
---

Read the session config's driver, and check its wiring (RFC 0020 Part 2c)

The deploy-runtime verdict keyed "backed session" on a constructed
`DatabaseSessionStore`, so an app that selects its store through a
`SessionManager` — everything `guren add session` scaffolds — was reported as
having no persistent store.

- `guren check`, `guren doctor` and the deploy builds now read a
  `SessionConfig`-annotated object's `stores` and `default`, resolving
  `process.env.SESSION_DRIVER ?? 'database'` through its literal fallback. A
  persistent selection satisfies the session remediation; selecting `memory`
  is its own warning; an unreadable `default` still counts as backed when every
  declared store is. The type annotation is the anchor, since a cache config
  keys `stores` identically.
- `guren check` gains two session rules: a `database` store bound to a table no
  schema module exports (which throws on the first session write), and a
  session config no provider binds as `session` (which leaves sessions on the
  in-memory default while looking configured). Apps with no session config
  contribute nothing.
- `appBindsService()` scans the app root it is given rather than the process
  working directory, so `runCheck({ cwd })` — the entry point the MCP server
  uses — judges the app under check.
