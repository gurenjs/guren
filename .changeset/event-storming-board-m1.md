---
'@guren/cli': minor
---

Event-storming boards (RFC 0041, the first milestone): a board is notes, arrows and sections in `docs/boards/<slug>.board.json`, for the stage before a plan, where the events, what causes them and the open questions are still being found. `guren board:new "<title>"` creates one, `guren board:show <slug>` prints it as an outline (each section's notes in flow order, every arrow on the note it leaves, questions under the note they are about), and `guren board:apply <slug> --ops <file|->` edits it with a list of operations: `add`, `edit`, `move`, `remove`, `connect`, `disconnect`, `link`, `section`, `unsection`. A note or section added without coordinates is placed for you, an operation that cannot apply is dropped and reported while the rest apply, and a write takes a lock under `.guren/boards/`. The development MCP server gains `guren_get_boards`, which lists the boards or returns one as its outline. A plan's `commands` may not run `board:*`.
