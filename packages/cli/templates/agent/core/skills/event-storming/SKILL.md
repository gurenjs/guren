---
name: event-storming
description: "Run an event-storming session with the person on a board (`docs/boards/<slug>.board.json`, RFC 0041) before a plan exists, for a change whose shape is not settled yet (\"let's storm this\", \"map the events\", \"what happens in the domain when …\"). Works in four stages and stops for the person after each, then hands the board to plan-write."
---

# Event-Storming Skill

A board is where the person and you work out a change before it is ready to
plan: what happens in the domain, who causes it, what follows, and what nobody
has decided. The person arranges the board on a canvas in the Dev Center, and
you read and edit the same file as text. The board carries no authority:
nothing checks it, approves it or runs from it. The plan written from it is
what gets reviewed.

When the change is already clear (the person can name the models, routes and
pages), skip the board and use `plan-write`.

## 0. Open the board

```bash
bunx guren board:show <slug>     # an existing board
bunx guren board:new "<title>"   # a new one; a title with no ASCII letters needs --slug
```

Write the notes in the language the person writes in; `board:new` takes the
app's default locale, and `--locale ja` sets another. Tell the person where to
see it: with the dev server running, `/_guren/boards/<slug>` on its port.

You edit the board through `board:apply`. Write the operations as a JSON
file outside the repository (your scratchpad or a temp directory), since
`plan:approve` refuses a tree with an untracked file, and pass its path.
Create the file with your file-writing tool, not a shell heredoc: a shell
command holding JSON braces and quotes is refused by some agents' checks.

```json
[
  { "op": "section", "id": "publishing", "title": "Publishing" },
  { "op": "add", "id": "post_published", "kind": "event", "text": "Post was published", "section": "publishing" }
]
```

```bash
bunx guren board:apply <slug> --ops <path to the file>
```

- You name every note: an id is lowercase letters, digits and `_`, starting
  with a letter, 2 to 32 characters. A note's text is one line of at most 280
  characters.
- Leave out coordinates. A note is placed next to `after`, or in `section`,
  and its position carries no meaning: never move the person's notes to tidy
  the board.
- An operation that cannot apply (a note the person removed meanwhile) is
  reported as dropped while the rest apply. Read what was dropped and decide
  again; do not resend it unchanged.

## The stages

Before every stage run `board:show <slug>` again: the person may have moved,
reworded or removed notes on the canvas, and their board is the one you build
on. After every stage, show the person what you added (the outline lines, not
the JSON), ask what is wrong or missing, and wait for their answer before the
next stage. Apply their corrections first.

1. **Events.** Only `event` notes: what happened, in the past tense ("Post
   was published"), one fact each. Put the ones that belong together in a
   `section` per flow. Read the app first (`bunx guren context`) so an event
   it already has keeps the name the person knows.
2. **Commands, actors, records and pages.** Before each event, the `command`
   that causes it ("Publish a post") and the `actor` who issues it. Beside
   the command, the `aggregate` it changes and the `view` the actor uses.
   Connect them in reading order: actor to command, command to aggregate,
   aggregate to event.
3. **Reactions and external systems.** After each event, the `reaction`
   that follows it ("When published, tell subscribers") and any `external`
   system it reaches. A step the caller does not wait for, such as a queued
   job or a mail, gets an async arrow: `{ "op": "connect", "from": …, "to": …,
   "kind": "async" }`.
4. **Questions.** One `question` note per thing nobody has decided, with
   `about` naming the notes it concerns ("Notify for a saved draft too?").
   Ask; do not decide for the person. A question the person answers becomes
   an edit to the notes, and the question is removed.

Stop when the person says the board has settled. A stage the person skips is
skipped. In a session nobody can answer in (`claude -p`, a scheduled run), go
through the four stages in one pass, leave everything you could not settle as
a question note, and stop at the board: tell the person it is ready to review.

## Hand off to a plan

```bash
bunx guren plan --from-board <slug> --print-prompt
```

Add the person's own request in quotes when they gave one. Follow the prompt
as the `plan-write` skill describes, from its step 0: it maps each note to
plan elements and asks the board's open questions. The plan never mentions
the board.

Once `plan:render` reports no failed check, record which note became which
element with `link` operations, then check them against the plan before the
person reviews it:

```bash
bunx guren board:status <slug> --plan docs/plans/<plan-slug>/plan.json
```

Every link should read `planned` or `present`. A `missing` link names
something the plan does not add: fix the link or the plan. Notes listed as
leading nowhere either need a link or belong in the plan's non-goals. Actors
and questions take no link.

Commit the board with its links before the person runs `plan:approve`, which
refuses a tree with uncommitted changes outside the plan's own files; commit it
again if they edit the canvas while reviewing. Once they approve the plan, the
board page shows the same result as `board:status` on each note.
