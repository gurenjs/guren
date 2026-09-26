---
"@guren/cli": patch
---

Return diagnostic failures from runCli without terminating the caller or leaking command status between invocations. Preserve report output and standalone CLI exit codes.
