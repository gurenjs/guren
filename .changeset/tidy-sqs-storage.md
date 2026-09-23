---
"@guren/server": minor
---

Use the SQS receive count to preserve retry limits across redeliveries and worker restarts. A polling adapter that reports no receive count warns once and keeps the previous behaviour.

Reject storage paths that leave a local disk through a symbolic link. Links that resolve inside the disk, and a configured root that is itself a link, keep working.
