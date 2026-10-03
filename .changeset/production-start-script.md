---
"create-guren-app": patch
---

Scaffolded apps gain a `start` script (`NODE_ENV=production bun bin/serve.ts`), the one way a deployment runs the server in production mode. HSTS, the `Secure` session cookie, hidden error details and the `APP_URL` host allowlist all key on `NODE_ENV=production`, and `bin/serve.ts` now warns at startup when `APP_URL` names a non-loopback host while `NODE_ENV` is not `production`. `APP_ENV` and `APP_DEBUG` are no longer declared in `config/env.ts` or `.env.example`: nothing read them, and `NODE_ENV` alone decides production mode.
