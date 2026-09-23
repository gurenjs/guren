---
'@guren/cli': patch
---

Every one-shot command now ends the process when it finishes, after stdout and stderr are flushed. Commands that import app code (`plan:status`, `plan:render`, `plan:verify`, `check`, `audit`, `context`, `route:list`, `tool:list`, `doctor`) used to print their output and then never exit when a routes or schema module left a timer or client open at import, such as a module-level `new MemoryRateLimitStore()`. `dev`, `tool:dev` and `console` keep running as before, and a plugin's command is left to end on its own.
