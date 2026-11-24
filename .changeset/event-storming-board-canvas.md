---
'@guren/cli': minor
---

The Dev Center's board page is now a canvas (RFC 0041, the second milestone). Notes of eight kinds can be added, edited, dragged in and out of sections, joined by arrows (dashed for an async step) and deleted; a question dropped on a note becomes about that note; sections move with their notes and resize; Ctrl or ⌘ with Z undoes the last edit; and the background pans and zooms. Every edit is saved to `docs/boards/<slug>.board.json` through the board's ops route as it is made, and the page reads the file again when the window regains focus, so an agent's edits made through `guren board:apply` appear. The canvas's words follow the board's locale (English or Japanese), and it is usable from the keyboard: Tab between notes, arrow keys to move, Enter to edit, Delete to remove, C to start an arrow. The outline `guren board:show` prints stays on the page, folded. A new guide, Event-Storming Boards, covers the boards end to end.
