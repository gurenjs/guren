---
"@guren/cli": patch
---

The agent harness's ORM rule lists the query builder's bulk update as `update(data, { set? })`, which `@guren/orm` 2.14.0 accepts, so an agent writes a server-chosen column there through `set` rather than `forceUpdate`.
