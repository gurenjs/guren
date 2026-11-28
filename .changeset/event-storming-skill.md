---
'@guren/cli': minor
---

The agent harness ships an `event-storming` skill (RFC 0041). It runs a session on a board in four stages and stops for the person after each: events; commands with their actors, aggregates and views; reactions and external systems; then questions. Once the board has settled it hands off to `plan --from-board`, records which note became which element with `link` operations, and checks them with `board:status --plan`. `plan-write` names the `--from-board` path. `bunx guren agent:sync` installs the skill in an existing app; the entry document's new sentence pointing a change whose shape is not settled yet to the skill reaches new apps only, since `agent:sync` leaves an existing `CLAUDE.md` alone.
