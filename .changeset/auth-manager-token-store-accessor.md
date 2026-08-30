---
"@guren/server": minor
---

Expose the configured API token store on `AuthManager` via `getApiTokenStore()`.

`useTokens(store)` closed over its store inside the guard factory, where nothing outside a live request could see it — so an issuance command could only ever write into a store of its own making, which no running app would read. The accessor returns the store `useTokens` was last configured with, or `undefined` when the app never called it, and is the one path by which `guren token:issue` (RFC 0016 §5.1) reaches an application's own store.

The reference is recorded at the end of `useTokens`, after its guard-shadowing check can throw, so a refused call leaves no store behind; a legal re-call replaces it alongside the guard it re-registers. Deliberately on the concrete class rather than on `AuthManagerContract`: the contract describes what a request needs from auth, and handing out the raw store is not part of that.
