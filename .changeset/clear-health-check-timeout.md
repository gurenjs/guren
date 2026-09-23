---
'@guren/server': patch
---

`HealthManager` now clears each check's timeout timer once the check settles. The timer used to stay pending for the full timeout (5 seconds by default) even after the check had passed, so a script or test that ran a health check waited that long to exit, and a frequently probed `/health` endpoint accumulated pending timers. A check that exceeds its timeout still reports `Health check timed out after <ms>ms`.
