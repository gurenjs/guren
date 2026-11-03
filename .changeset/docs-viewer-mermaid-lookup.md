---
"@guren/server": patch
---

The docs viewer picks up `mermaid` as soon as it is installed: after `bun add -d mermaid`, reloading the page renders the diagrams without restarting the dev server. The asset is read from `node_modules/mermaid/dist/mermaid.min.js` in the app root or its nearest ancestor, since Bun's module resolver remembers a failed lookup for the life of the process.
