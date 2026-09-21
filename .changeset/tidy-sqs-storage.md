---
"@guren/server": patch
---

Use the SQS receive count to preserve retry limits across redeliveries and worker restarts. Custom polling adapters must expose the receive count; dispatch-only adapters remain compatible.

Reject symbolic links below local storage roots to prevent reads and writes through links outside the configured disk. The configured root itself may still be a symbolic link.
