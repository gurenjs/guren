---
"@guren/server": patch
---

Return managed Vite startup failures to Application.listen callers instead of terminating the process, and close a created Vite server when startup fails. Centralize HTTP and Vite ownership, bounded shutdown, and process teardown in an internal lifecycle module while preserving restart and hot-reload behavior.
