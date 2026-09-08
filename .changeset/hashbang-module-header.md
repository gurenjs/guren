---
'@guren/cli': patch
---

`guren/comment-length` now gives the module-header allowance (8 lines) to the JSDoc under a `#!/usr/bin/env bun` line. oxc reports the hashbang as a comment, so it was taking the header slot and leaving the real header on the 5-line body limit — which is what the hook scripts an app scaffolds are written against.
