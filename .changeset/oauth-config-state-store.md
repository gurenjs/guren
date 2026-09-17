---
'@guren/server': minor
'@guren/core': minor
---

`defineOAuthConfig` accepts `stateStore`, which the bound OAuth manager keeps authorize states in, so a definition can hold them in the database (`new DatabaseOAuthStateStore(oauthStates)`) rather than in process memory (RFC 0027 §2).
