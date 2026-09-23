---
'@guren/cli': patch
---

`plan:status` and `plan:close` no longer tell you to add a behaviour for an element a planned step's behaviours already reach. When that step's verified run no longer holds (a fingerprinted file changed, or it never ran), the note names the step and says to run `plan:verify` on it, matching the remedy line `plan:close` prints below it.
