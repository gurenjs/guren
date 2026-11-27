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

## From a board to a plan

When the board has settled, ask your agent for a plan and point it at the board:

```text
Read the board with `bunx guren board:show post-notifications` and write an implementation plan from it.
Every event and reaction becomes a side effect, every command a route and an action, and every open question a plan question.
```

The plan's own checks, review page and approval then take over, as described in [Implementation Plans](./implementation-plans.md).

## Limits

A board holds at most 500 notes, 2,000 arrows and 100 sections, and a note's text is one line of at most 280 characters. The canvas stays responsive at 500 notes: dragging a note moves it without delay, and releasing it redraws the board in about 15 milliseconds, before the save reaches the server.
