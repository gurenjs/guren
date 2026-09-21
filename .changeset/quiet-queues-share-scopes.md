---
"@guren/server": minor
"@guren/core": patch
"@guren/cli": patch
---

Isolate concurrent container scopes and make Redis queue transitions atomic. Fence stale reservations and renew active leases while handlers run. Jobs can pass `this.signal` to cancellable I/O; timeouts request cancellation and retries wait for the handler to settle. Worker lifecycle state is reset after driver failures.

Remove the CLI's runtime dependency on the core facade by sharing registration conventions below both packages. Document queue delivery guarantees, mass-assignment boundaries and the supported runtime baseline.
