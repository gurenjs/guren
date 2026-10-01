---
"@guren/cli": patch
---

Dev Center's `/_guren/graph.json` now answers every request with a scan that started after the request arrived. A request made while a scan is running waits for one follow-up scan, shared by every request that arrived during it, so "Refresh graph" after saving a file no longer returns a snapshot from before the edit.
