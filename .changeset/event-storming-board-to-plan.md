---
'@guren/cli': minor
---

Plan from an event-storming board (RFC 0041 §3). `guren plan --from-board <slug> --print-prompt` quotes the board's outline in the planning prompt, after the request and between markers named by a hash of it, and tells the agent how notes become plan elements: events and reactions side effects, commands routes and actions, aggregates models, views views, questions plan questions and sections flows. Once the plan passes `plan:render`, the agent records which note became which element with `link` operations through `board:apply`. The plan gains no reference to the board.

`guren board:status <slug>` reports, per linked note, whether the application has the element (`present`), an open plan adds it (`planned`) or neither does (`missing`), and lists the notes that lead nowhere. `--plan <file>` judges against one plan whether or not it is approved. It reads the application as `plan:status` does, importing `db/schema.ts` and the validator files, and always exits 0. A plan's `commands` may not run it.
