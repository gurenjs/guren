---
'@guren/cli': patch
---

The profile controller `guren make:auth` scaffolds checks the current password through the `web` guard by name. Unqualified, a request carrying `Authorization: Bearer` resolved the token guard, whose `validate()` throws, so a profile update over an API token failed with a 500. An address that differs from the stored one only in case is now treated as unchanged throughout `update()`, so it no longer clears the verified status or sends a verification mail. Apps scaffolded earlier are not modified.
