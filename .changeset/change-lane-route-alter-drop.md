---
'@guren/cli': minor
---

`guren change:lane` lowers a removed or changed route to `low` when one open plan's `drop` or `alter` route states it (RFC 0040 §3). A removal is declared at the route's name, method and path while no later route of its method or `ALL` could answer its requests. A change is declared when the name, module and action stay, only the method, path, middleware, bindings or `.agent()` changed, and each is as planned; a moved route is held to the overlap rule at both paths, and its `agent-tool` fact follows it. A change to the action's validation or authorization stays `medium`.
