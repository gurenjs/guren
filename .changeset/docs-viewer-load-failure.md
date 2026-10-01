---
'@guren/cli': patch
---

Say so when the docs viewer cannot load its data. The page polls `/_guren/docs/data.json` and returned quietly on an error response, so a payload the server failed to build left the page blank on the first load, or showed the last loaded graph as current. A notice under the counters now names the HTTP status (the dev server's output has the error), or that the server stopped answering, or that the payload would not parse, and says whether what is on screen is from an earlier load. One unanswered poll goes unreported, since a dev server restarting under `bun --hot` gives one. The notice clears on the next successful poll.
