---
'@guren/cli': patch
---

The docs viewer keeps mermaid 11's diagram layout and look when the app installs mermaid 12. Mermaid 12 lays out flowchart, class, state and ER diagrams with ELK and draws them in its `neo` look by default; the viewer now passes `layout: 'dagre'` and `look: 'classic'` to `mermaid.initialize()`, keys mermaid 11 reads as well.
