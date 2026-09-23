---
'@guren/server': patch
---

`HealthManager` now clears each check's timeout timer once the check settles. The timer used to stay pending for the full timeout (5 seconds by default) even after the check had passed, so a script or test that ran a health check waited that long to exit, and a `/health` endpoint kept one pending timer per check for up to the timeout after every probe. A check that exceeds its timeout still reports `Health check timed out after <ms>ms`.
