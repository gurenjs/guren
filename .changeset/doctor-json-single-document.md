---
'@guren/cli': patch
---

`guren doctor --json` writes one JSON document to stdout. The command printed the versioned report (`{ version: 1, … }`) and then the raw internal report after it, so stdout could not be parsed as JSON. Only the versioned report is printed now.
