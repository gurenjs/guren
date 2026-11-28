---
'@guren/cli': minor
---

The agent harness ships an `event-storming` skill (RFC 0041). It runs a session on a board in four stages and stops for the person after each: events; commands with their actors, aggregates and views; reactions and external systems; then questions. Once the board has settled it hands off to `plan --from-board`, records which note became which element with `link` operations, and checks them with `board:status --plan`. `plan-write` names the `--from-board` path, and the entry document points a change whose shape is not settled yet to the new skill. Run `bunx guren agent:sync` to install it in an existing app.
