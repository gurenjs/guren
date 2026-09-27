---
"@guren/cli": minor
"@guren/server": minor
---

The docs viewer at `/_guren/docs` reads what a closed implementation plan (RFC 0030) leaves behind. A plan document is its own node kind and shows the hash it closed at; a block `plan:close` wrote into an entity document is framed and links to its plan; acceptance tests verifying the same documents collapse into one node that lists each id with the test files carrying it (a toggle expands them). A plan whose page `plan:render` wrote beside it opens at `/_guren/docs/plans/<slug>`, served by `@guren/server` through the new `docsViewerPlanPage()` in `@guren/cli`. The detail panel can be resized by dragging its left edge, and the panel's top bar no longer lets content show through above it while scrolling.
