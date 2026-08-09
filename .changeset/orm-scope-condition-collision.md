---
'@guren/orm': patch
---

Refuse a query whose conditions collide on a scoped column

On an adapter without `findManyAdvanced`/`countAdvanced`, conditions are
flattened into one where-object, so a second condition on a field overwrote the
first. A global scope pinning `tenantId` was therefore replaced by a caller's own
`where('tenantId', …)` — the filter meant to enforce isolation handed back
another tenant's rows. Only a repeat of the same value collapses now; a genuine
conflict throws, like the operators that already cannot be flattened.
