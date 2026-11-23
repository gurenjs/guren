# RFC: The Board: Event Storming Before a Plan

**Author:** Guren contributors
**Date:** 2026-11-23
**Status:** Draft

## Problem

An implementation plan (RFC 0030) starts where the design is already decided
enough to name models, routes and actions. The step before that has no place in
Guren: which events the domain has, who causes them, what reacts to them, and
what nobody has decided yet. Today that step happens in the chat with the
agent, where it is lost when the session ends, or on a whiteboard that nothing
reads.

Three things were measured on `main` at `ee94bf9e` (2026-11-23).

1. **The plan's own vocabulary for behaviour goes unused.** A plan can declare
   `flows` and `sideEffects`, and the JSON Schema sent with the producer
   prompt defines both. The prose of `buildPlanPrompt()`
   (`packages/cli/src/plan/prompt.ts`) never mentions a flow, so an agent
   writing a plan is not asked for one. The evidence here is thin: the only
   plan files committed to this repository are three test fixtures, and none
   declares either section.
2. **A flow is a placed graph, and that is the wrong tool for diverging.**
   RFC 0030 §3 has Guren lay a flow out (longest-path layering) and forbids a
   plan from carrying positions. That is right for a document a person
   approves: one flow is one picture wherever it is drawn. Event storming works
   the other way. People put notes down first and find the structure by moving
   them, so the position of a note is the work in progress.
3. **The application's event flow is not read.** `examples/blog` declares four
   events, two listeners, three jobs, four mails and one notification;
   `PostController.store` emits `PostCreated` and `SendNewPostNotification`
   listens for it. The Application Graph (RFC 0032) has eight node kinds and
   seven relations and none of them is an event, a listener or a job.
   `packages/cli/src/plan/side-effect-uses.ts` already finds those call sites,
   but only to answer whether a planned side effect is `wired`.

So a team that wants to model before planning leaves Guren to do it, and what
they bring back is prose pasted into `guren plan "<request>"`.

## Proposed Solution

A **board** is a document of notes, arrows and sections that a person arranges
on a canvas in the Dev Center and an agent reads and edits as text. It sits in
front of the plan: `guren plan --from-board` puts it into the producer prompt.
It carries no authority. Nothing checks it against the application as a gate,
nothing approves it, and nothing executes it; the plan written from it goes
through the §2 checks and `plan:approve` as any other plan does.

The design has five parts, shipped in that order (see Phasing).

### 1. The board document

`docs/boards/<slug>.board.json`, committed. The schema lives in
`packages/cli/src/board/schema.ts`. A slug matches `^[a-z0-9][a-z0-9-]{0,63}$`,
and `boardSlug()` in that module is the one place that says so: the commands
and the Dev Center routes both refuse any other string before a path is built
from it.

```ts
export const BOARD_NOTE_KINDS = [
  'actor', 'view', 'command', 'aggregate', 'event', 'policy', 'external', 'question',
] as const

interface BoardNote {
  id: string                 // ^[a-z][a-z0-9_]{1,31}$, unique among the board's notes
  kind: (typeof BOARD_NOTE_KINDS)[number]
  text: string               // plain text, at most 280 characters
  x: number                  // board units, a multiple of 8, 0..16000
  y: number
  section?: string           // the section the note belongs to
  about?: string[]           // a `question` note: the notes it questions
  link?: BoardLink           // the application element the note stands for
}

interface BoardArrow { from: string; to: string; kind?: 'async' }

interface BoardSection {
  id: string; title: string
  x: number; y: number; width: number; height: number
}

interface Board {
  boardVersion: 1
  title: string
  locale: string             // BCP 47, as a plan's
  notes: BoardNote[]         // at most 500
  arrows: BoardArrow[]
  sections: BoardSection[]
}
```

The kinds are the usual event-storming colours, and each maps onto what a plan
already declares:

| Kind | Colour | Plan element it leads to |
| --- | --- | --- |
| `actor` | yellow | the `actor` of a behaviour |
| `view` | green | `views` (an Inertia page) |
| `command` | blue | `routes` and the controller action |
| `aggregate` | pale yellow | `models` |
| `event` | orange | `sideEffects` of kind `event` |
| `policy` | lilac | `sideEffects` of kind `listener`, `job`, `mail`, `notification` |
| `external` | pink | a flow node of kind `external` |
| `question` | red | `questions` |

Three rules keep the document readable by both of its readers.

- **Geometry is never meaning.** Everything an agent is told about a board
  comes from ids, kinds, arrows, `section` and `about`. Coordinates only draw,
  and no reader derives membership from them. When a person drops a note
  inside a section, or a question onto a note, the page sends that as an
  explicit operation beside the move, so a person never types either.
- **The writer of a note names it.** An agent picks a readable id
  (`post_published`); the page generates `n_` and eight random characters. An
  id is unique among the notes present, and a removed id may be added again,
  which is how undo restores a note with its arrows' ends intact.
- **Sizes are the page's.** A note stores no width or height. A section does,
  since a person sizes it. A section cannot be made smaller than the notes
  that belong to it, and moving it moves them.
- **One serialization.** Fixed key order, two-space indent, notes and sections
  sorted by id, arrows by `from` then `to`. Two edits to different notes touch
  different lines, so git merges them.

A link names an element by the name a plan gives it. For a model, a route, an
action and a page that is the name the §2 checks judge by
(`packages/cli/src/plan/app-targets.ts`): the class, the route name,
`Class.action`, the component path. A side effect is named by its class, the
`name` of a `sideEffects` entry. `module` applies to every kind but `page`,
whose path already carries the module.

```ts
interface BoardLink {
  kind: 'model' | 'route' | 'action' | 'page' | 'event' | 'listener' | 'job' | 'mail' | 'notification'
  name: string
  module?: string
}
```

A link is optional. A board with no link at all is a complete board.

Every string on a board is written by an agent or pasted by a person, so it is
treated as a plan string is (RFC 0030 §3): the page writes it with
`textContent` only and no board string becomes an `href`.

### 2. Editing a board

**The canvas.** `/_guren/boards` lists the boards and `/_guren/boards/<slug>`
opens one. Both are views of the Dev Center's one shell: a module
`packages/cli/src/dev-center-page/board.ts` beside `plans.ts` and `ui.ts`, in
the bundle `devCenterShell()` composes, under the shell's
`Content-Security-Policy`. They read `/_guren/boards.json` and
`/_guren/boards/<slug>/board.json`. The view draws notes as positioned
elements and arrows as SVG, with no dependency. A person can:

- add a note of a kind, edit its text, move it, delete it;
- connect two notes, and mark an arrow `async`;
- add, rename, resize and delete a section;
- pan, zoom, select several notes and move them together, and undo within the
  session;
- do all of it from the keyboard: a note takes focus, arrow keys move it,
  Enter edits it.

The page's own words come from an `en` and `ja` dictionary held to key parity,
as the plan page's are.

**The write.** The canvas saves with `POST /_guren/boards/<slug>/ops`. RFC 0032
calls the plan feedback route "the Dev Center's only write" and gives the
reason: "The Dev Center cannot tell the person from the agent's browser that
`browser:serve` points at it, which is why no button writes." This RFC amends
that rule, and two things about the new route are new. It is a second write,
and it is the first to a tracked file: the feedback route writes the
git-ignored `.guren/plans/`, while a board is committed. The reason behind the
rule still holds, because the board route carries no decision. What an agent's
browser could write through it, the agent can already write to the file, and
no command reads a board as approval.

The route is guarded in two places, as the feedback route is.

- `@guren/server` mounts every Dev Center path by hand
  (`packages/server/src/mcp/McpServiceProvider.ts`). The board paths join that
  list behind `createMcpAccessGuard()` and `isMcpEndpointEnabled()`. The POST
  is its own route there, which requires the request's `Origin` to be its own
  origin before the CLI sees it. The CSRF middleware exempts only the feedback
  path today (`isDevCenterFeedbackRequest()`), so the board path gets the same
  exemption on the same terms; without it an application with auth answers the
  POST with a CSRF failure.
- The CLI handler checks the `Origin` again, requires `application/json`
  within `readWithinLimit()`, and validates the operations and the resulting
  board against the schema (`packages/cli/src/dev-center-review.ts` is the
  pattern).

The body is a list of operations, never the whole document:

```ts
type BoardOp =
  | { op: 'add'; id: string; kind: NoteKind; text: string; at?: { x: number; y: number }; after?: string; section?: string; about?: string[] }
  | { op: 'edit'; id: string; text?: string; kind?: NoteKind; section?: string | null; about?: string[] }
  | { op: 'move'; id: string; x: number; y: number }
  | { op: 'remove'; id: string }
  | { op: 'connect'; from: string; to: string; kind?: 'async' }
  | { op: 'disconnect'; from: string; to: string }
  | { op: 'link'; id: string; link: BoardLink | null }
  | { op: 'section'; id: string; title: string; at?: { x: number; y: number; width: number; height: number } }
  | { op: 'unsection'; id: string }
```

`applyBoardOps(board, ops)` in `packages/cli/src/board/ops.ts` is pure, and
these are its rules.

- Operations in one list apply in order, so a list can add a note and then
  connect it.
- An `add` whose id is present, and any operation naming a note or section
  that is absent, is dropped and reported; the rest apply. Applying a list a
  second time therefore changes nothing.
- `remove` also removes the arrows that touch the note and takes its id out of
  every `about`. A question left with an empty `about` stays, unattached.
  `unsection` clears `section` on the notes that named it and leaves them
  where they are.
- A `section` with no `at` is placed below the last section at a default
  size, and grows as notes are placed in it. An agent names a section; it
  never sizes one.
- `edit`, `move` and `link` on different notes commute. An `add` with no `at`
  is placed against what is already there, so the order of two such adds
  decides where they sit and nothing else: the ids, kinds, arrows, `section`
  and `about` come out the same, which is all the outline reads.

The writer takes `.guren/boards/<slug>.lock`, created exclusively and holding
its process id, for one read, apply and `writeFileAtomic()`. A lock whose
process is gone is removed. A lock whose process is alive is waited on for up
to five seconds and then reported as an error naming the process; it is never
broken, since breaking a live holder's lock is how one of two writes is lost
after both reported success. The response is the board as written plus the
dropped operations, and the page replaces its state with it. It also reads the
board again when the window regains focus.

**The agent's path.** An agent never computes a coordinate.

```bash
bunx guren board:new "Post notifications" --slug post-notifications
bunx guren board:show post-notifications            # the text form; --json for the document
bunx guren board:apply post-notifications --ops ops.json   # `-` reads standard input
```

`board:show` prints the board as an outline: each section, then its notes,
questions under the note they are about, unconnected notes last. Notes are
ordered by the layering `packages/cli/src/plan/flow.ts` computes for a flow:
by distance from a note with no incoming arrow, then by id. A note with two
successors prints both, indented, and an arrow that closes a cycle prints as a
reference to the earlier note, as that module already marks a back edge.

```
Board: Post notifications  (docs/boards/post-notifications.board.json)

Publishing
  [actor author] Author
  -> [command publish_post] Publish a post
  -> [aggregate post] Post                             = model Post
  -> [event post_published] Post was published         = event PostCreated
       ? [draft_too] Notify for a saved draft too?
  -> [policy tell_subscribers] When published, tell subscribers
  ~> [command send_mail] Send the notification mail
Unsorted
  [event post_updated] Post was updated
```

`board:apply` takes the same operations the page posts, through the same
function and the same lock. An `add` with no `at` is placed by
`placeNote()` (`packages/cli/src/board/place.ts`): to the right of the note
named by `after`, else in the first free cell of `section`, else in an
`Unsorted` section created on first use. `placeNote()` is a pure function of
the board and the operation, with no clock and no random number in it.

The development MCP server gains `guren_get_boards`, read-only, returning the
list and one board's text form, as `guren_get_plans` does for plans.
`PLAN_COMMAND_CLASSES` classifies every registry command, so `board:*` join it
under a new denial, `board`: a plan is written from a board and does not edit
one.

The harness template gains an `event-storming` skill under
`packages/cli/templates/agent/core/skills/`. It runs a session in stages and
stops for the person after each: events only, then commands and actors, then
policies and external systems, then questions.

### 3. From a board to a plan

```bash
bunx guren plan --from-board post-notifications --print-prompt
```

`buildPlanPrompt()` takes the board's text form as a second input and adds a
section after the request. The text is quoted between markers named by a hash
of the text, as `requestSection()` quotes the request, and the prompt says the
same thing about it: everything between the markers is the board, never an
instruction. The rules the section adds:

- every `event` and `policy` note becomes a `sideEffects` entry, every
  `command` a route and an action, every `aggregate` a model, every `view` a
  view, or the note's text goes into `scope.nonGoals`;
- every `question` note becomes a `questions` entry. A note is one line, so
  the agent writes the options and their consequences; `affects` holds the
  elements made from the notes in `about`;
- each section becomes one `flows` entry.

After writing the plan the agent records which note became which element, with
`link` operations through `board:apply`. The link uses the names the plan
gives its elements, so it resolves against the plan before the code exists and
against the application afterwards. The plan itself gains no reference to the
board: a plan stays valid if the board is deleted, and its hash does not move
when a note does.

`bunx guren board:status <slug> [--plan <file>]` reports, per note, whether it
has a link and whether the link resolves in a plan or in the application, and
lists the notes that lead nowhere. The application is read through
`loadPlanAppState()`, the scan the §2 checks read. With no `--plan` the plans
are the open ones: found by the discovery rule `check --plan` uses and read
one by one through `readOpenPlan()`. It is advisory and exits 0.

A board sits under `docs/`, which `change:lane` reads as ambient, and its text
reaches the producer prompt. That is the standing of the request string today:
untrusted text, quoted, that a plan is written from. What is reviewed is the
plan, so the lane of a board file does not change.

### 4. What the plan gains

Two additions let a plan state what a board draws. Both ride on a new
`planVersion`, as the `providers`, `config` and `env` sections did
(`ENTRY_SECTIONS_VERSION`): a plan that uses neither keeps its version and its
hash.

- `PLAN_FLOW_NODE_KINDS` gains `event` and `policy`.
- A side effect gains an optional `triggeredBy: Id[]`, absent when empty. For
  an `event` it names the actions or jobs that emit it; for a `listener`, the
  event it listens for; for a `job`, `mail` or `notification`, the actions,
  listeners or jobs that dispatch or send it. `trigger`, the prose, stays.

`triggeredBy` joins the reference table in
`packages/cli/src/plan/references.ts`, so the §2 checks reject an id that
resolves to nothing. `plan:status` judges it as a planned property: `match`
when the reader of part 5 finds the use inside the named member, `differ` when
it finds the class used only elsewhere, `unknown` when a file did not parse or
the application registers listeners through `AutoDiscovery`.

In `REFERENCE_CARRIES_BEHAVIOUR` the new reference is `false`. A test of the
route that passes says nothing about whether the event was emitted, so a side
effect still closes on its own behaviour, on acceptance at approval, or on a
waiver (Open Question 3).

### 5. Reading the application's events

`side-effect-uses.ts` reports which files use a side-effect class. It is
extended to report the class member the use sits in, found through
`classActionMembers()`, and for a listener the event its `static event` names.

The Application Graph gains the node kinds `event`, `listener`, `job`, `mail`
and `notification` and the relations `emits`, `listens`, `dispatches` and
`sends`, all with `static` evidence. Coverage follows RFC 0032's rule: a file
that did not parse, or listeners found through `AutoDiscovery`, make the
section `partial` with the reason, never a complete empty one.

Three things read the new edges.

- **The board's overlay.** A linked note shows `present` (the application has
  the element), `planned` (an open plan adds it, by `readOpenPlan()`) or
  `missing`. An arrow between two linked notes is marked when the graph has no
  matching edge. The overlay is drawn in the page and written nowhere.
- **`guren board:new --from-app [--entity <Model>]`** seeds a board from the
  graph, one note per command, aggregate, event and policy, each linked, laid
  out by the layering `packages/cli/src/plan/flow.ts` already implements. This
  is how an existing application gets its event map: as a board a person can
  then rearrange.
- **`docs/spec/events.md`**, a fifth spec view beside `er`, `domain`,
  `screens` and `modules`, generated by `spec:generate` and held by
  `check --spec`. Like the other views it reads source only, never the
  introspected application, so it is the same bytes in the gate and in the edit
  hook.

### Package boundaries

Most of it is in `@guren/cli`: `src/board/` (schema, operations, placement,
text form), `src/dev-center-page/board.ts`, `src/commands/board.ts`, the
branches in `createDevCenterHandler()` and the harness skill. No new
dependency.

M2 also changes `@guren/server`, which owns the mount: the board paths in
`McpServiceProvider.ts`, the POST route with its `Origin` check, and the CSRF
exemption in `packages/server/src/mcp/endpoint.ts`. That is an additive minor
of `@guren/server`. The two packages version apart, so both pairings have to
behave. An older CLI under a newer server answers the board paths with 404
from its own handler. A newer CLI under an older server has no board routes
mounted, so the Dev Center home reads `/_guren/boards.json` before it shows
the link, and on a 404 says which `@guren/server` the canvas needs. M1 and M3
need no server at all.

### Phasing

| Milestone | Ships | Usable alone |
| --- | --- | --- |
| M1 | The document, `board:new`, `board:show`, `board:apply`, `guren_get_boards` | An agent and a person edit a board as text |
| M2 | The canvas and its write route | A person arranges the board in the Dev Center |
| M3 | `plan --from-board`, `link` operations, `board:status`, the harness skill | A storming session ends in a plan |
| M4 | `event` and `policy` flow nodes, `triggeredBy`, its `plan:status` property | The plan states the event flow and status checks it |
| M5 | The graph's event kinds and relations, the overlay, `--from-app`, `docs/spec/events.md` | An existing application's events appear on a board |

M2 is the largest piece. If it slips, M1 and M3 still give a session its
record and its plan, with the board read as an outline.

### Non-goals

- Free drawing, images, text styling, note colours beyond the eight kinds.
- Presence, cursors, comments or any real-time multi-user state. Two writers
  are supported through operations and git, never through a live session.
- Importing from or exporting to an external whiteboard.
- A board as a gate. No check fails on a board and no command refuses because
  of one.
- Enforcing aggregate boundaries in code. An `aggregate` note leads to a
  model; what a module may import stays `guren.arch.ts`'s rule (RFC 0002).
- Serving the canvas outside development. It is part of the Dev Center, which
  is mounted only while `isMcpEndpointEnabled()` holds (`GUREN_MCP=1`, never
  in production) and behind the loopback guard.

## Alternatives Considered

**Draw the event flow inside the plan page, in fixed columns.** The first
sketch for this RFC put actor, view, command, aggregate, event and policy in
six columns, one row per flow. It needs no new document. It also cannot hold
a note that is not yet a plan element, which is every note in the first half
of a session, and nothing can be moved.

**Use FigJam or Miro and have the agent read it.** An agent can read a FigJam
file through Figma's MCP server today, so this costs almost nothing to build.
It requires an account with a third party for a local development tool, the
board lives outside the repository's history and review, and the two things
only Guren can add are lost: a note kind that maps to a plan element, and the
application's state drawn on the note.

**A text DSL or Mermaid in `docs/`.** It is diffable and needs no canvas. It
is also authored by typing, which is how a plan is authored already. The gap
this RFC fills is the stage where arranging is the thinking.

**Store positions in the plan.** One document instead of two. RFC 0030 §3
forbids a plan from carrying a layout so that a flow draws the same
everywhere, and every moved note would rename an approved plan through its
hash.

**Build the canvas on a library (tldraw, React Flow, Excalidraw).** Each
brings a React runtime into the Dev Center, whose page ships none, and RFC
0030 §3 records why the plan page declined one. The Dev Center's
`Content-Security-Policy` allows only inline scripts it has hashed and
`default-src 'none'`, so a library that fetches a chunk or a font at run time
does not load. Notes, arrows and sections are a small enough set to draw
directly.

**Keep the board under `.guren/`, uncommitted.** Simpler writes and no merge
question. The board is the record of why a plan has the shape it has, and a
git-ignored file is gone on the next clone.

**Synchronize live through a CRDT.** It would make two browsers see each other
at once. It needs a socket, a persistence format that is no longer readable
JSON, and a dependency, for a tool one person and one agent use at a time.

## Migration Path

M1 to M3 are additive. An application with no board sees no file created and
no check added, and the Dev Center gains one link. The canvas needs the
`@guren/server` release that mounts its routes (see Package boundaries).

A plan that declares no `triggeredBy` and no `event` or `policy` flow node
keeps its `planVersion` and its hash. A revision that adds the first one moves
the plan to the new version, as a revision adding the first `providers` entry
moves a version 1 plan to version 2. A CLI older than that version does not
read such a plan, as a CLI that predates version 2 does not read one with a
`providers` section.

The Application Graph's new kinds and relations are the one change an existing
consumer can see (Open Question 4).

## Open Questions

1. **How the canvas learns of an agent's edit.** The proposal reads the board
   again on focus and after every write, close to the Dev Center's present
   rule of one read on open and a refresh button (RFC 0032). A person watching
   an agent work sees nothing until they click.
   Server-sent events from the write path would fix that at the cost of the
   Dev Center's first held connection.
2. **The board after the plan exists.** The proposal leaves it editable and
   lets `board:status --plan` show what drifted: a note added since, a link
   that no longer resolves. Nothing revises the plan from it. The alternative
   is to freeze the board when its plan is approved and require a new board
   for a revision.
3. **Whether `triggeredBy` carries a behaviour.** As proposed it does not. If
   it did, a verified test of the route would lift the event it emits and the
   listener behind it, which removes most waivers for side effects and also
   lets a side effect close with nothing asserting it ran.
4. **The graph's `schemaVersion`.** `kind` and `relation` are closed enums in
   the published schema, so a strict consumer of version 1 rejects the new
   values. Either the version moves to 2, or version 1 is declared open to new
   kinds and the Dev Center's reader, which accepts only 1, stays as it is.
5. **Slugs for non-ASCII titles.** A Japanese title has no ASCII slug.
   `board:new` as proposed requires `--slug` then. Deriving one from the date
   is the alternative.
6. **One board across modules.** A link carries `module`, so a board can span
   modules. Whether a section should be able to name the module its notes
   default to is not decided.
7. **The ceiling of 500 notes.** It is a guess. The canvas should be measured
   with a board of that size before M2 ships, and the number set from the
   result.
8. **Whether a board is a node in the docs graph.** `docs:graph` could draw a
   board with edges to the entities its notes link to and to the plan made
   from it. Nothing in this RFC needs it.
