# Event-Storming Boards

A board is where you work out a change before it is ready to plan: the events your domain has, who or what causes them, what reacts to them, and what nobody has decided yet. You arrange notes on a canvas in the Dev Center, and your agent reads and edits the same board as text. When the shape is clear, the board becomes the input for an [implementation plan](./implementation-plans.md).

A board carries no authority. No check fails because of one, nothing approves it, and nothing runs from it. The plan you write from it is checked and approved like any other plan.

## Create a board

```bash
bunx guren board:new "Post notifications"
```

The board is written to `docs/boards/post-notifications.board.json`, and you commit it with the rest of your work. The slug comes from the title. A title with no ASCII letters needs one of its own:

```bash
bunx guren board:new "投稿の公開通知" --slug post-notifications
```

The canvas uses English or Japanese for its buttons, following the language the notes are written in. `--locale` sets it; without the flag, the board takes your app's default locale.

## Note kinds

Each note has a kind, drawn in the colour event storming uses for it:

| Kind | Colour | What it stands for |
|---|---|---|
| `actor` | yellow | a person or role who acts |
| `view` | green | a page they look at |
| `command` | blue | something they ask the app to do |
| `aggregate` | pale yellow | the record a command changes |
| `event` | orange | something that happened |
| `reaction` | lilac | what follows an event (a listener, a job, a mail) |
| `external` | pink | a system outside your app |
| `question` | red | something not decided yet |

Event storming calls the lilac note a policy. Guren names it `reaction`, because a policy in Guren is an authorization class.

## Arrange it in the Dev Center

Start your app with the Dev Center enabled (the scaffolded `bun run dev` already sets `GUREN_MCP=1`) and open `http://localhost:3333/_guren/boards`, using your app's port. The Dev Center home lists the boards too.

On a board's page:

- **Add a note** by picking its kind from the **Add a note** menu, or double-click empty space for another note of the last kind you used. **Connect**, **Async** and **Delete** appear beside it while something they apply to is selected.
- **Drag** a note to move it. Drop it inside a section and it belongs to that section; drag it out and it no longer does. Shift-click selects several notes, which then move together.
- **Edit** a note's text by double-clicking it, or select it and press Enter.
- **Connect** two notes: select the first, press C (or **Connect**), then click the second. Select an arrow and press **Async** for a step the caller does not wait for, such as a queued job; the arrow turns dashed.
- **Ask a question about a note** by dropping a question onto it. The question then sits beside the note, joined to it by a dotted line.
- **Sections** group notes. Drag a section by its title to move it with its notes, and drag its bottom-right corner to resize it.
- **Delete** removes what is selected, and Ctrl or ⌘ with Z takes back your last edit. Undo puts back only what that edit changed and nobody has changed since, so anything your agent changed meanwhile stays. An edit the file did not take, such as removing a note your agent had already removed, has nothing to undo.

From the keyboard, Tab moves between notes and section titles. The arrow keys move what is selected (hold Shift for larger steps), Enter edits it, and Delete removes it. To connect two notes, press C on the first, Tab to the second and press Enter. Selecting an arrow, selecting several notes and resizing a section need a pointer.

Drag the background to pan, and hold Ctrl or ⌘ while scrolling to zoom, or use the buttons in the canvas's bottom-right corner. Every edit is saved to the board file as you make it. When you come back to the window, the page reads the file again, so an edit your agent made in the meantime appears.

## Let your agent read and edit it

Your agent works with the same board as text. `board:show` prints an outline, with the notes of each section in flow order and every arrow on the note it leaves:

```bash
bunx guren board:show post-notifications
```

```text
Board: Post notifications  (docs/boards/post-notifications.board.json)

Publishing [publishing]
  [actor author] Author  -> publish_post
  [command publish_post] Publish a post  -> post
  [aggregate post] Post  -> post_published
  [event post_published] Post was published  ~> tell_subscribers
      ? [draft_too] Notify for a saved draft too?
  [reaction tell_subscribers] When published, tell subscribers
```

`~>` is an async arrow. A question prints under the note it is about. Coordinates never appear in the outline, and nothing reads meaning from them.

`board:apply` edits the board with a list of operations. The agent names each note it adds, and a note added without coordinates is placed next to the note given as `after`, or in the section given as `section`:

```bash
bunx guren board:apply post-notifications --ops ops.json
```

```json
[
  { "op": "add", "id": "post_updated", "kind": "event", "text": "Post was updated", "after": "post_published" },
  { "op": "connect", "from": "publish_post", "to": "post_updated" }
]
```

The operations are `add`, `edit`, `move`, `remove`, `connect`, `disconnect`, `link`, `section` and `unsection`. An operation that cannot apply, such as one that names a note that is gone, is reported and skipped, and the rest still apply. You and your agent can therefore edit one board at the same time without losing each other's work. Agents connected to the Dev MCP endpoint can also read boards through the `guren_get_boards` tool.

The agent harness in a scaffolded app ships an `event-storming` skill for running a session with your agent. Ask for one ("let's storm post notifications") and the agent works in four stages, stopping for you after each so you can correct the board on the canvas or in chat:

1. events only;
2. the commands that cause them, with the actors, the records they change and the pages they use;
3. the reactions that follow each event and the external systems they reach;
4. a question note for each thing nobody has decided.

When you say the board has settled, the skill hands it to the plan, as the next section describes.

## From a board to a plan

When the board has settled, print the planning prompt with the board in it and give it to your agent:

```bash
bunx guren plan --from-board post-notifications --print-prompt
```

The prompt quotes the board's outline after your request, and you can add a request of your own in quotes. It tells the agent how notes become plan elements:

| Note | In the plan |
|---|---|
| `event`, `reaction` | a side effect, whose trigger comes from the arrows into the note |
| `command` | a route and the action it calls |
| `aggregate` | a model |
| `view` | a view |
| `question` | a plan question, about the elements its notes became |
| a section | a flow |

A note the change turns out not to need goes into the plan's non-goals. The plan's own checks, review page and approval then take over, as described in [Implementation Plans](./implementation-plans.md).

Once the plan passes `plan:render`, the agent records which note became which element with `link` operations. A link names the element as the plan does: a model's class, a route's name, `Class.action` for an action, a view's page, a side effect's class. A command note links to its route, and actors and questions get no link.

```json
[{ "op": "link", "id": "post_published", "link": { "kind": "event", "name": "PostPublished" } }]
```

The plan never mentions the board, so deleting the board or moving a note leaves the plan and its approval as they were.

## See where each note went

`board:status` reports, for every linked note, whether its element exists:

```bash
bunx guren board:status post-notifications --plan docs/plans/post-notifications/plan.json
```

```text
Board: Post notifications  (docs/boards/post-notifications.board.json)
Plans: docs/plans/post-notifications/plan.json (given)

Linked notes:
  present   [aggregate post] Post  = model Post
  planned   [event post_published] Post was published  = event PostPublished  (docs/plans/post-notifications/plan.json)
  missing   [command publish_post] Publish a post  = route posts.publish

Lead nowhere (2):
  [command publish_post] Publish a post  = route posts.publish (missing)
  [reaction tell_subscribers] When published, tell subscribers  (no link)
```

`present` means your app has the element, `planned` that a plan adds it, and `missing` that neither does. `unknown` means part of your app or a plan could not be read, so the command cannot tell. **Lead nowhere** lists the missing links and the notes with no link that could have one, so actors and questions are left out. Without `--plan`, the command reads the plans that are approved and not yet closed. With it, it reads that one plan whether or not it is approved, which is how your agent checks its links before you review the plan. The command reads your app as `plan:status` does, so it loads `db/schema.ts` and your validators. It only reports: once the board and the plan are read, it exits 0.

The board page in the Dev Center shows the same result on the notes. Each linked note carries a badge, **In the app**, **Planned**, **Missing** or **Unknown**, and the line under the canvas counts them and names the plans it read. The page checks when you open the board, when you press **Refresh board**, and when you come back to the window, at most once every 15 seconds. It reads the approved plans that are not yet closed, as `board:status` does without `--plan`. A note whose link changed since the last check shows no badge until the next one.

## Limits

A board holds at most 500 notes, 2,000 arrows and 100 sections, and a note's text is one line of at most 280 characters. The canvas stays responsive at 500 notes: dragging a note moves it without delay, and releasing it redraws the board in about 15 milliseconds, before the save reaches the server.
