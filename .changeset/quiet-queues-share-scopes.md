---
"@guren/server": minor
"@guren/core": patch
"@guren/cli": patch
---

Isolate concurrent container scopes and make Redis queue transitions atomic. Fence stale reservations and renew active leases while handlers run. Jobs can pass `this.signal` to cancellable I/O; timeouts request cancellation and retries wait for the handler to settle. A handler that completes after its timeout is acknowledged rather than retried, a failed lease renewal is retried at the next heartbeat, and a lease another worker took is reported per job without stopping the worker. `SqsDriver` renews message visibility while a job runs (`visibilityTimeout` option) and `SqsAdapter.changeMessageVisibility` may resolve `false` for an expired receipt. Worker lifecycle state is reset after driver failures.

Remove the CLI's runtime dependency on the core facade by sharing registration conventions below both packages. Document queue delivery guarantees, mass-assignment boundaries and the supported runtime baseline.
