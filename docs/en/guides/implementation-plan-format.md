# Writing an Implementation Plan

This page describes the plan file itself: its sections, element ids and changes, acceptance behaviours, questions and commands. For the workflow that renders, approves and implements it, see [Implementation Plans](./implementation-plans.md); the words this page uses (element, behaviour, step) are defined in its [Terms](./implementation-plans.md#terms) table.

## The document

| Field | Holds |
|---|---|
| `planVersion` | `1` |
| `title`, `summary`, `locale` | What the plan is about, and the language its prose is written in (`en`, `ja`), view labels excepted |
| `scope` | `goals` and `nonGoals` |
| `assumptions`, `questions` | What the plan decided without being told, and what it could not decide |
| `models`, `validators`, `controllers`, `routes`, `views`, `resources`, `policies`, `sideEffects` | The design, one section per kind of element |
| `flows` | How a request moves through what the plan adds, as nodes and edges |
| `commands` | Commands such as `guren add attachments` the change needs first |
| `tasks` | What each slice must achieve, and its acceptance behaviours |
| `hints` | Ordering advice, such as `task/entity/model.tag before task/entity/model.comment` |
| `baseline` | Written by `plan:approve`, never by hand |

Every section may be left out. An omitted section and an empty one are the same plan.

## Ids and changes

Every element carries an `id` and a `change`. Ids share one namespace across the whole plan, start with a letter, and may contain letters, digits, `_`, `.`, `:` and `-`; the convention is the section and a name (`model.comment`, `route.comments.store`). Other elements refer to each other by these ids, and a revision later names an element by its id alone, so keep them stable.

| `change.kind` | Meaning |
|---|---|
| `existing` | Referenced and left as it is |
| `add` | New |
| `alter` | Changed in place |
| `rename` | Renamed; `from` is the old name (a model's class, a column's property, a route's name) |
| `drop` | Removed; `reason` says why |

An `alter`, `rename` or `drop` of an existing table or column must say what happens to its rows with `dataMigration`: `{ "kind": "none", "reason": "…" }`, `backfill` or `manual` with a `description`. The plan is refused without one:

```text
  column.post.summary: Column "summary" of "Post" is a "rename" on an existing table and states no dataMigration.
```

A model lists only the columns the plan touches or references. This is the new `Comment` model from the example, cut to two of its five columns:

```json
{
  "id": "model.comment",
  "change": { "kind": "add" },
  "name": "Comment",
  "table": "comments",
  "columns": [
    {
      "id": "column.comment.body",
      "name": "body",
      "change": { "kind": "add" },
      "type": "text",
      "nullable": false,
      "unique": false,
      "index": false
    },
    {
      "id": "column.comment.postId",
      "name": "postId",
      "columnName": "post_id",
      "change": { "kind": "add" },
      "type": "integer",
      "nullable": false,
      "unique": false,
      "index": true,
      "references": { "model": "model.post", "column": "id", "onDelete": "cascade" }
    }
  ],
  "relationships": [
    { "name": "post", "type": "belongsTo", "target": "model.post" },
    { "name": "author", "type": "belongsTo", "target": "model.user" }
  ],
  "fillable": ["body"]
}
```

Column types are an abstract vocabulary rather than Drizzle builders: `string`, `text`, `integer`, `number`, `decimal`, `boolean`, `date`, `datetime`, `json`, `uuid`. `datetime` takes `withTimezone`, and `decimal` takes `precision` and `scale`.

The other sections follow the same pattern. A controller holds its actions, each with the validator its `body`, `params` or `query` uses, its `authorization` (middleware, and a policy ability), its `response` (an Inertia view, a redirect, a resource) and its business `rules` as prose. A route names its method, path, name, action id, middleware and `bind`. A view names its page id, its props, and a form whose fields point at a validator's fields rather than restating their rules. Its form field and action labels are the text the page shows, so they are written in the application's default locale even when the rest of the plan is in another language: the browser specs look for them on a page rendered in that locale. Elements in an application module carry `module`.

## Acceptance behaviours

A task intent names an entity, the elements it covers, and the behaviours that prove it works:

```json
{
  "id": "AC-comments-4",
  "description": "A user cannot delete someone else's comment.",
  "kind": "forbidden",
  "actor": "user",
  "route": "route.comments.destroy",
  "given": ["a comment written by another user exists"],
  "expect": { "status": 403 }
}
```

`kind` is one of `success`, `validation`, `unauthenticated`, `forbidden`, `not-found` and `state`. The checks count them on the routes the plan adds or alters: a route with a validator and no `validation` behaviour, or with authentication and no `unauthenticated` one, is reported. `expect` takes `status`, `redirect`, `inertia`, `errors` and `database`; request `input` and database values are written as `{ "name": "body", "json": "\"Nice post\"" }`, the value as JSON text.

Each behaviour becomes a test whose title carries its id in brackets. Start acceptance ids with `AC-`: `plan:verify` reports a bracketed `AC-` token that the plan does not declare, which is how a mistyped id gets caught.

```ts
test("[AC-comments-4] a user cannot delete someone else's comment", async () => {
  const comment = await Comment.forceCreate({ body: 'Mine', postId: post.id, userId: author.id })
  await http.actingAs(reader).delete(`/comments/${comment!.id}`).assertStatus(403)
})
```

Guren redirects a non-GET request with 303, so a behaviour that expects the redirect after a form post says `"status": 303`.

A behaviour that holds before the plan's work carries `"alreadyHolds": true`. The usual one is an `unauthenticated` behaviour on a route the plan alters and that is behind authentication today: a guest is sent to sign in already, and the plan must keep it that way.

```json
{
  "id": "AC-comments-6",
  "description": "A guest is sent to sign in before editing a post.",
  "kind": "unauthenticated",
  "actor": "guest",
  "route": "route.posts.edit",
  "given": [],
  "alreadyHolds": true,
  "expect": { "redirect": "/login" }
}
```

The `tests` step asks every behaviour's test to fail before the implementation exists, which a test of what already holds cannot do. A marked behaviour is asked for its test only, and the step that runs the tests still needs it to pass. Leave the mark off when the plan adds the guard itself: that test fails until the work is done. An `existing` route needs no `unauthenticated` behaviour at all.

`plan:render` warns on its page, which the Dev Center review shows, about a behaviour whose test may pass before its implementation exists: one with nothing to set up, on a route that exists already or that an earlier task mounts. On a route that exists, mark it if it guards what already holds, or give it a setup or an expectation that only the planned work meets. On a route an earlier task adds, move it to that task, whose tests step sees it fail. A mark is a warning too where the behaviour cannot hold yet: nothing answers its route, an earlier task of the plan adds the route, or the plan puts authentication on a route the application serves without it today.

## Questions

A question is a decision the author could not make alone, with the options, the one the plan assumed, and the elements that change if the answer differs:

```json
{
  "id": "Q-delete",
  "question": "Does deleting a comment remove the row?",
  "options": [
    { "label": "hard delete", "consequence": "The row is removed; no deleted_at column." },
    { "label": "soft delete", "consequence": "A deleted_at column is added and lists filter on it." }
  ],
  "assumed": "hard delete",
  "affects": ["model.comment", "action.comments.destroy"]
}
```

A plan with an open question cannot be approved. Answer it by editing the plan: apply the answer, remove the question, and record the decision under `assumptions`. Before approval, editing `plan.json` by hand is the normal way to change it.

## Commands

`plan:next` hands a plan's `commands` to the implementing agent, which runs them as written. Each one therefore has to be a Guren generator:

```json
{ "id": "command.attachments", "command": "guren add attachments", "reason": "Comments take images." }
```

A command passes when it reads `guren <subcommand>` or `bunx guren <subcommand>` and the subcommand is a `make:*` generator other than `make:migration`, `lang:publish`, or `add <blueprint>` other than `add plugin`. Arguments may hold letters, digits and `_-.,:/=@+%`, with single or double quotes around a value that has spaces (`--fields "title:string,body:text?"`). A shell operator, `$`, a backslash or an unclosed quote fails the check, and so does an argument that is an absolute path or climbs out with `..` (`--path /etc`, `--app=../other`). The check bounds shell syntax and where a generator may write; it does not judge each generator's other flags, such as `--force`. Every other command fails too: `bun run db:migrate` runs as the `data` step's verify command, not from the plan. `plan:approve` refuses while this check fails, and `plan:next` hands out no step of a plan that carries such a command, draft or not.

The commands run first, before any step builds what the plan declares, so `commands` are for what the plan does not declare. A second check fails a generator for an element the plan adds or renames where running it first breaks a later step:

- In an app that is not API-only, `plan:scaffold` writes each model the plan adds in the project root, with its table, validators, resources, policies, controllers, routes and side effects, and refuses a target that already exists. `guren make:model Comment` beside an added `Comment` model is refused there.
- A blueprint that declares an added model's table in `db/schema.ts` makes a second declaration beside the data step's, and some blueprints generate a migration for it too: `guren add session` beside an added model on the `sessions` table does both.
- Output that imports what no step has written yet fails the commands step's typecheck: `guren make:factory CommentFactory` imports a `Comment` model the plan adds.

A stub that no scaffold writes and nothing imports passes, such as a job the plan adds in a task with no added model: its step edits the stub. The finding names the element and the step that writes it, and `plan:approve` refuses on it too.
