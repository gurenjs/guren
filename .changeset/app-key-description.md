---
'create-guren-app': patch
---

The `APP_KEY` description in a new app's `config/env.ts` no longer says the key encrypts session payloads. The default session store keeps the data on the server and the cookie carries only a signed session id; the payload is encrypted only under the opt-in `cookie` session driver.
