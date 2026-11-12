---
'@guren/cli': patch
'create-guren-app': patch
---

The profile controller `make:auth` and the blog template generate logs the user in again only after a password change. `login()` binds the session to the password hash stored at that moment, so the unconditional call let a name-only update carry a session past a password reset that landed during the request.
