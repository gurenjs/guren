---
"@guren/cli": patch
---

Place a plan action with the task that covers it or the routes to it, not with an uncovered controller in Foundation. Foundation's `http` step could verify only by mounting those routes, which made a task's validation, forbidden and unauthenticated behaviours pass before its `tests` step saw them fail, so `tests:fail` never verified.
