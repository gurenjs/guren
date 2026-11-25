---
'@guren/server': patch
---

A login for an email address no account holds now costs what a wrong password costs. `ModelUserProvider` verifies the submitted password against a dummy hash made once by the same hasher, where `SessionGuard` used to wait a fixed 100 ms, which differed from a real verification by enough to tell registered addresses apart by response time. Custom user providers can do the same by implementing the new optional `verifyMissingUser(credentials)` method on `UserProvider`; one without it keeps the 100 ms wait. Logins for unknown addresses now spend a full password verification, as they do in Laravel and Django.
