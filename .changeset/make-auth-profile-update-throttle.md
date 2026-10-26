---
'@guren/cli': patch
---

`guren make:auth` now throttles `PUT /profile` per signed-in user with `throttleProfileUpdate` from `app/Http/Middleware/AuthThrottle.ts`: five requests carrying a current password per minute, so a stolen session cannot guess the password the profile form asks for before it changes the account's email or password. A save without a current password (a name change) is not counted, and an Inertia request shows the message under the current password field. `--oauth-only` output is unchanged, and apps scaffolded earlier are not modified.
