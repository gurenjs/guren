---
'@guren/server': patch
---

Remember the options `useTokens()` configured its guard with, and expose them as `AuthManager.getApiTokenOptions()`. Machinery that replaces the token store without meaning to change anything else — `guren tool:dev` installs an ephemeral store over the app's — could otherwise only call `useTokens(store)`, which silently dropped the app's `provider`: a token then resolved to a bare `{ id }` instead of the real user record, and every policy reading a user field behaved differently for no stated reason.
