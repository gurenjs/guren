---
'@guren/cli': minor
---

`guren change:lane` reads an edit to a file an approved, open plan added as that plan's addition (RFC 0040 §3): when the newest commit on the merge base's history that added the plan's approvals file did not have the file, and every route's security record was compared, the edit is `file-added` (marked `planAddition`, in `record.json` too), held to the check the file's addition takes, and `low` where it passes. An edited policy stays `medium`.
