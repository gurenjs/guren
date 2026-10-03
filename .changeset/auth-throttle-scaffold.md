---
"@guren/cli": minor
"create-guren-app": minor
---

Throttle sign-in by default. `guren make:auth` (and `guren add auth`) now writes `app/Http/Middleware/AuthThrottle.ts` and mounts it on `POST /login`, `POST /register` and `POST /forgot-password`, counting requests per client IP and submitted email. Past the limit an Inertia form shows the translated `auth.throttle` / `auth.too_many_requests` message as a validation error, and other clients get a 429. The command writes `lang/en/auth.json` with those keys unless the app already has one. The blog starter ships the same throttles on login and registration.
