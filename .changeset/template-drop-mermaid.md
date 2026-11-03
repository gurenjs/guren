---
"create-guren-app": patch
---

The default template no longer lists `mermaid` as a devDependency. mermaid depends on katex, so `guren audit` (A06) reported a katex advisory on every fresh app, for a library only the docs viewer uses. Without it the viewer shows each diagram's source with a `bun add -d mermaid` hint; run that command to render diagrams. An app scaffolded earlier keeps `mermaid`, and `bun remove mermaid` clears the warning if you do not need rendered diagrams.
